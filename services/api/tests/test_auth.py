from datetime import UTC, datetime

import orbit_api.main as orbit_main
import pytest
from fastapi.testclient import TestClient
from orbit_api.auth import (
    AgentAuthenticationError,
    GoogleIdentity,
    SessionTokenStore,
    _validate_google_payload,
)


def _google_payload(**overrides: object) -> dict[str, object]:
    payload: dict[str, object] = {
        "iss": "https://accounts.google.com",
        "aud": "client-id.apps.googleusercontent.com",
        "email": "student@sic.shibaura-it.ac.jp",
        "email_verified": "true",
        "exp": 2_000_000_000,
    }
    payload.update(overrides)
    return payload


def test_google_identity_payload_is_scoped_to_verified_sit_accounts(monkeypatch) -> None:
    monkeypatch.setenv(
        "ORBIT_GOOGLE_OAUTH_CLIENT_ID",
        "client-id.apps.googleusercontent.com",
    )
    monkeypatch.setenv(
        "ORBIT_GOOGLE_ALLOWED_DOMAINS",
        "sic.shibaura-it.ac.jp,shibaura-it.ac.jp",
    )

    identity = _validate_google_payload(_google_payload(), now=1_900_000_000)
    assert identity == GoogleIdentity(email="student@sic.shibaura-it.ac.jp")

    for invalid in (
        {"iss": "https://evil.example"},
        {"aud": "another-client"},
        {"email_verified": "false"},
        {"email": "student@gmail.com"},
        {"exp": 1_800_000_000},
    ):
        with pytest.raises(AgentAuthenticationError):
            _validate_google_payload(_google_payload(**invalid), now=1_900_000_000)


def test_session_tokens_are_opaque_hashed_and_expire() -> None:
    store = SessionTokenStore(ttl_seconds=60)
    token, expires_at = store.issue(now=1_000)

    assert token
    assert expires_at == datetime.fromtimestamp(1_060, tz=UTC)
    assert token not in str(store._tokens)
    assert store.verify(token, now=1_059.999)
    assert not store.verify(token, now=1_060)
    assert not store.verify(token, now=1_060)


def test_auth_session_exchanges_id_token_without_returning_the_identity_token(
    monkeypatch,
) -> None:
    monkeypatch.delenv("ORBIT_API_TOKEN", raising=False)
    monkeypatch.setenv("ORBIT_AGENT_BACKEND", "fixture")

    async def fake_verify(id_token: str) -> GoogleIdentity:
        assert id_token == "google-id-token"
        return GoogleIdentity(email="student@sic.shibaura-it.ac.jp")

    monkeypatch.setattr(orbit_main, "verify_google_id_token", fake_verify)

    with TestClient(orbit_main.app) as client:
        response = client.post(
            "/v1/auth/session",
            json={"id_token": "google-id-token"},
        )

        assert response.status_code == 200
        body = response.json()
        assert body["access_token"] != "google-id-token"
        assert body["expires_at"]

        capabilities = client.get(
            "/v1/capabilities",
            headers={"Authorization": f"Bearer {body['access_token']}"},
        )

    assert capabilities.status_code == 200


def test_auth_session_rejects_untrusted_identity(monkeypatch) -> None:
    monkeypatch.delenv("ORBIT_API_TOKEN", raising=False)

    async def reject(_: str) -> GoogleIdentity:
        raise AgentAuthenticationError("invalid")

    monkeypatch.setattr(orbit_main, "verify_google_id_token", reject)

    with TestClient(orbit_main.app) as client:
        response = client.post(
            "/v1/auth/session",
            json={"id_token": "untrusted"},
        )

    assert response.status_code == 401
    assert response.json() == {"detail": "Agent authentication failed."}
