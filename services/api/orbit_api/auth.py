"""Short-lived authentication for the managed browser extension connection."""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import secrets
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from google.auth.transport.requests import Request as GoogleAuthRequest
from google.oauth2 import id_token as google_id_token


class AgentAuthenticationError(ValueError):
    """Raised when a browser identity cannot be trusted for an Agent session."""


class AgentAuthenticationUnavailable(RuntimeError):
    """Raised when managed authentication is unavailable or misconfigured."""


@dataclass(frozen=True)
class GoogleIdentity:
    email: str


def _configured_domains() -> set[str]:
    values = os.getenv(
        "ORBIT_GOOGLE_ALLOWED_DOMAINS",
        "sic.shibaura-it.ac.jp,shibaura-it.ac.jp",
    )
    return {value.strip().lower() for value in values.split(",") if value.strip()}


def _oauth_configuration() -> tuple[str, str, str]:
    client_id = os.getenv("ORBIT_GOOGLE_OAUTH_CLIENT_ID", "").strip()
    client_secret = os.getenv("ORBIT_GOOGLE_OAUTH_CLIENT_SECRET", "").strip()
    redirect_uri = os.getenv("ORBIT_GOOGLE_OAUTH_REDIRECT_URI", "").strip()
    if not client_id or not client_secret or not redirect_uri:
        raise AgentAuthenticationUnavailable("Managed Agent authentication is not configured.")
    return client_id, client_secret, redirect_uri


def _exchange_google_authorization_code(
    authorization_code: str,
    code_verifier: str,
) -> str:
    client_id, client_secret, redirect_uri = _oauth_configuration()
    body = urlencode(
        {
            "code": authorization_code,
            "client_id": client_id,
            "client_secret": client_secret,
            "redirect_uri": redirect_uri,
            "grant_type": "authorization_code",
            "code_verifier": code_verifier,
        }
    ).encode("utf-8")
    request = Request(
        "https://oauth2.googleapis.com/token",
        data=body,
        headers={
            "Accept": "application/json",
            "Content-Type": "application/x-www-form-urlencoded",
        },
        method="POST",
    )
    try:
        with urlopen(request, timeout=8) as response:  # noqa: S310 - fixed Google URL
            payload = json.loads(response.read().decode("utf-8"))
    except HTTPError as error:
        if error.code in {400, 401}:
            raise AgentAuthenticationError("Google authorization code was rejected.") from error
        raise AgentAuthenticationUnavailable("Google token exchange is unavailable.") from error
    except Exception as error:  # pragma: no cover - network failures are mocked in tests
        raise AgentAuthenticationUnavailable("Google token exchange is unavailable.") from error
    if not isinstance(payload, dict):
        raise AgentAuthenticationUnavailable("Google token exchange returned an invalid response.")
    returned_id_token = payload.get("id_token")
    if not isinstance(returned_id_token, str) or not returned_id_token:
        raise AgentAuthenticationError("Google identity token was not returned.")
    return returned_id_token


def _validate_google_payload(payload: dict[str, Any], now: float | None = None) -> GoogleIdentity:
    client_id = os.getenv("ORBIT_GOOGLE_OAUTH_CLIENT_ID", "").strip()
    if not client_id:
        raise AgentAuthenticationError("Managed Agent authentication is not configured.")

    issuer = str(payload.get("iss", "")).strip()
    if issuer not in {"accounts.google.com", "https://accounts.google.com"}:
        raise AgentAuthenticationError("Google identity verification failed.")
    if payload.get("aud") != client_id:
        raise AgentAuthenticationError("Google identity verification failed.")
    if not str(payload.get("sub", "")).strip():
        raise AgentAuthenticationError("Google identity verification failed.")
    if str(payload.get("email_verified", "")).lower() != "true":
        raise AgentAuthenticationError("Google identity verification failed.")

    email = str(payload.get("email", "")).strip().lower()
    if "@" not in email:
        raise AgentAuthenticationError("Google identity verification failed.")
    domain = email.rsplit("@", 1)[1]
    if domain not in _configured_domains():
        raise AgentAuthenticationError("Google identity verification failed.")
    hosted_domain = str(payload.get("hd", "")).strip().lower()
    if hosted_domain not in _configured_domains():
        raise AgentAuthenticationError("Google identity verification failed.")

    try:
        expires_at = float(payload["exp"])
    except (KeyError, TypeError, ValueError) as error:
        raise AgentAuthenticationError("Google identity verification failed.") from error
    if expires_at <= (time.time() if now is None else now):
        raise AgentAuthenticationError("Google identity verification failed.")
    return GoogleIdentity(email=email)


def _verify_google_id_token(id_token: str, client_id: str) -> dict[str, Any]:
    try:
        payload = google_id_token.verify_oauth2_token(
            id_token,
            GoogleAuthRequest(),
            client_id,
        )
    except ValueError as error:
        raise AgentAuthenticationError("Google identity verification failed.") from error
    except Exception as error:  # pragma: no cover - transport failures are mocked in tests
        raise AgentAuthenticationUnavailable(
            "Google identity verification is unavailable."
        ) from error
    if not isinstance(payload, dict):
        raise AgentAuthenticationError("Google identity verification failed.")
    return payload


async def exchange_google_authorization_code(
    authorization_code: str,
    code_verifier: str,
) -> GoogleIdentity:
    """Exchange one-time code material and verify the returned Google identity."""

    client_id, _, _ = _oauth_configuration()
    returned_id_token = await asyncio.to_thread(
        _exchange_google_authorization_code,
        authorization_code,
        code_verifier,
    )
    payload = await asyncio.to_thread(_verify_google_id_token, returned_id_token, client_id)
    return _validate_google_payload(payload)


class SessionTokenStore:
    """In-memory hashed session tokens that expire on process restart."""

    def __init__(self, ttl_seconds: int = 900) -> None:
        self._ttl_seconds = max(60, min(ttl_seconds, 3600))
        self._tokens: dict[str, float] = {}

    def clear(self) -> None:
        self._tokens.clear()

    def issue(self, now: float | None = None) -> tuple[str, datetime]:
        current = time.time() if now is None else now
        self._prune_expired(current)
        expires = current + self._ttl_seconds
        token = secrets.token_urlsafe(32)
        self._tokens[self._digest(token)] = expires
        return token, datetime.fromtimestamp(expires, tz=UTC)

    def verify(self, token: str, now: float | None = None) -> bool:
        current = time.time() if now is None else now
        self._prune_expired(current)
        digest = self._digest(token)
        expires = self._tokens.get(digest)
        if expires is None:
            return False
        if expires <= current:
            self._tokens.pop(digest, None)
            return False
        return True

    def _prune_expired(self, now: float) -> None:
        for digest, expires in list(self._tokens.items()):
            if expires <= now:
                self._tokens.pop(digest, None)

    @staticmethod
    def _digest(token: str) -> str:
        return hashlib.sha256(token.encode("utf-8")).hexdigest()
