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
from urllib.parse import urlencode
from urllib.request import Request, urlopen


class AgentAuthenticationError(ValueError):
    """Raised when a browser identity cannot be trusted for an Agent session."""


@dataclass(frozen=True)
class GoogleIdentity:
    email: str


def _configured_domains() -> set[str]:
    values = os.getenv(
        "ORBIT_GOOGLE_ALLOWED_DOMAINS",
        "sic.shibaura-it.ac.jp,shibaura-it.ac.jp",
    )
    return {value.strip().lower() for value in values.split(",") if value.strip()}


def _fetch_google_token_info(id_token: str) -> dict[str, Any]:
    query = urlencode({"id_token": id_token})
    request = Request(
        f"https://oauth2.googleapis.com/tokeninfo?{query}",
        headers={"Accept": "application/json"},
    )
    try:
        with urlopen(request, timeout=8) as response:  # noqa: S310 - fixed Google URL
            payload = json.loads(response.read().decode("utf-8"))
    except Exception as error:  # pragma: no cover - network failures are mocked in tests
        raise AgentAuthenticationError("Google identity verification failed.") from error
    if not isinstance(payload, dict):
        raise AgentAuthenticationError("Google identity verification failed.")
    return payload


def _validate_google_payload(payload: dict[str, Any], now: float | None = None) -> GoogleIdentity:
    client_id = os.getenv("ORBIT_GOOGLE_OAUTH_CLIENT_ID", "").strip()
    if not client_id:
        raise AgentAuthenticationError("Managed Agent authentication is not configured.")

    issuer = str(payload.get("iss", "")).strip()
    if issuer not in {"accounts.google.com", "https://accounts.google.com"}:
        raise AgentAuthenticationError("Google identity verification failed.")
    if payload.get("aud") != client_id:
        raise AgentAuthenticationError("Google identity verification failed.")
    if str(payload.get("email_verified", "")).lower() != "true":
        raise AgentAuthenticationError("Google identity verification failed.")

    email = str(payload.get("email", "")).strip().lower()
    if "@" not in email:
        raise AgentAuthenticationError("Google identity verification failed.")
    domain = email.rsplit("@", 1)[1]
    if domain not in _configured_domains():
        raise AgentAuthenticationError("Google identity verification failed.")

    try:
        expires_at = float(payload["exp"])
    except (KeyError, TypeError, ValueError) as error:
        raise AgentAuthenticationError("Google identity verification failed.") from error
    if expires_at <= (time.time() if now is None else now):
        raise AgentAuthenticationError("Google identity verification failed.")
    return GoogleIdentity(email=email)


async def verify_google_id_token(id_token: str) -> GoogleIdentity:
    """Verify through Google's tokeninfo endpoint without retaining the token."""

    payload = await asyncio.to_thread(_fetch_google_token_info, id_token)
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
        expires = current + self._ttl_seconds
        token = secrets.token_urlsafe(32)
        self._tokens[self._digest(token)] = expires
        return token, datetime.fromtimestamp(expires, tz=UTC)

    def verify(self, token: str, now: float | None = None) -> bool:
        current = time.time() if now is None else now
        digest = self._digest(token)
        expires = self._tokens.get(digest)
        if expires is None:
            return False
        if expires <= current:
            self._tokens.pop(digest, None)
            return False
        return True

    @staticmethod
    def _digest(token: str) -> str:
        return hashlib.sha256(token.encode("utf-8")).hexdigest()
