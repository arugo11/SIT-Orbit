from datetime import UTC, datetime
from email.message import Message
from urllib.error import HTTPError
from urllib.parse import parse_qs

import orbit_api.auth as orbit_auth
import orbit_api.main as orbit_main
import pytest
from fastapi.testclient import TestClient
from orbit_api.auth import (
    AgentAuthenticationError,
    AgentAuthenticationUnavailable,
    GoogleIdentity,
    SessionTokenStore,
    _exchange_google_authorization_code,
    _validate_google_payload,
)


def _google_payload(**overrides: object) -> dict[str, object]:
    payload: dict[str, object] = {
        "iss": "https://accounts.google.com",
        "sub": "google-account-id",
        "aud": "client-id.apps.googleusercontent.com",
        "email": "student@sic.shibaura-it.ac.jp",
        "email_verified": "true",
        "hd": "shibaura-it.ac.jp",
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
        {"sub": ""},
        {"email_verified": "false"},
        {"email": "student@gmail.com"},
        {"hd": "gmail.com"},
        {"hd": ""},
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


def test_session_token_issue_prunes_expired_tokens_without_a_verify_call() -> None:
    store = SessionTokenStore(ttl_seconds=60)
    store.issue(now=1_000)
    store.issue(now=1_010)
    assert len(store._tokens) == 2

    store.issue(now=1_060)

    assert len(store._tokens) == 2


def test_google_code_exchange_uses_pkce_and_does_not_request_offline_access(
    monkeypatch,
) -> None:
    monkeypatch.setenv("ORBIT_GOOGLE_OAUTH_CLIENT_ID", "web-client-id")
    monkeypatch.setenv("ORBIT_GOOGLE_OAUTH_CLIENT_SECRET", "server-only-secret")
    monkeypatch.setenv(
        "ORBIT_GOOGLE_OAUTH_REDIRECT_URI",
        "https://extension.chromiumapp.org/agent-auth",
    )
    captured: dict[str, object] = {}

    class TokenResponse:
        def __enter__(self) -> "TokenResponse":
            return self

        def __exit__(self, *_: object) -> None:
            return None

        def read(self) -> bytes:
            return b'{"id_token":"server-side-id-token","access_token":"discarded"}'

    def fake_urlopen(request: object, timeout: int) -> TokenResponse:
        captured["request"] = request
        captured["timeout"] = timeout
        return TokenResponse()

    monkeypatch.setattr(orbit_auth, "urlopen", fake_urlopen)

    returned_id_token = _exchange_google_authorization_code("one-time-code", "v" * 43)

    assert returned_id_token == "server-side-id-token"
    request = captured["request"]
    assert isinstance(request, orbit_auth.Request)
    assert request.full_url == "https://oauth2.googleapis.com/token"
    assert request.get_method() == "POST"
    assert captured["timeout"] == 8
    assert isinstance(request.data, bytes)
    form = parse_qs(request.data.decode("utf-8"))
    assert form == {
        "code": ["one-time-code"],
        "client_id": ["web-client-id"],
        "client_secret": ["server-only-secret"],
        "redirect_uri": ["https://extension.chromiumapp.org/agent-auth"],
        "grant_type": ["authorization_code"],
        "code_verifier": ["v" * 43],
    }
    assert "access_type" not in form


@pytest.mark.parametrize(
    ("status", "expected_error"),
    [
        (400, AgentAuthenticationError),
        (401, AgentAuthenticationError),
        (500, AgentAuthenticationUnavailable),
    ],
)
def test_google_code_exchange_classifies_provider_errors(
    monkeypatch,
    status: int,
    expected_error: type[Exception],
) -> None:
    monkeypatch.setenv("ORBIT_GOOGLE_OAUTH_CLIENT_ID", "web-client-id")
    monkeypatch.setenv("ORBIT_GOOGLE_OAUTH_CLIENT_SECRET", "server-only-secret")
    monkeypatch.setenv(
        "ORBIT_GOOGLE_OAUTH_REDIRECT_URI",
        "https://extension.chromiumapp.org/agent-auth",
    )

    def reject(*_: object, **__: object) -> None:
        raise HTTPError(
            "https://oauth2.googleapis.com/token",
            status,
            "error",
            Message(),
            None,
        )

    monkeypatch.setattr(orbit_auth, "urlopen", reject)

    with pytest.raises(expected_error):
        _exchange_google_authorization_code("rejected-code", "v" * 43)


def test_auth_session_exchanges_authorization_code_without_returning_google_material(
    monkeypatch,
) -> None:
    monkeypatch.delenv("ORBIT_API_TOKEN", raising=False)
    monkeypatch.setenv("ORBIT_AGENT_BACKEND", "fixture")

    async def fake_exchange(code: str, verifier: str) -> GoogleIdentity:
        assert code == "one-time-code"
        assert verifier == "v" * 43
        return GoogleIdentity(email="student@sic.shibaura-it.ac.jp")

    monkeypatch.setattr(orbit_main, "exchange_google_authorization_code", fake_exchange)

    with TestClient(orbit_main.app) as client:
        response = client.post(
            "/v1/auth/session",
            json={"authorization_code": "one-time-code", "code_verifier": "v" * 43},
        )

        assert response.status_code == 200
        body = response.json()
        assert body["access_token"] not in {"one-time-code", "v" * 43}
        assert body["expires_at"]

        capabilities = client.get(
            "/v1/capabilities",
            headers={"Authorization": f"Bearer {body['access_token']}"},
        )

    assert capabilities.status_code == 200


def test_auth_session_rejects_untrusted_identity(monkeypatch) -> None:
    monkeypatch.delenv("ORBIT_API_TOKEN", raising=False)

    async def reject(_: str, __: str) -> GoogleIdentity:
        raise AgentAuthenticationError("invalid")

    monkeypatch.setattr(orbit_main, "exchange_google_authorization_code", reject)

    with TestClient(orbit_main.app) as client:
        response = client.post(
            "/v1/auth/session",
            json={"authorization_code": "untrusted", "code_verifier": "v" * 43},
        )

    assert response.status_code == 401
    assert response.json() == {"detail": "Agent authentication failed."}


def test_auth_session_reports_managed_authentication_outage(monkeypatch) -> None:
    monkeypatch.delenv("ORBIT_API_TOKEN", raising=False)

    async def unavailable(_: str, __: str) -> GoogleIdentity:
        raise AgentAuthenticationUnavailable("provider unavailable")

    monkeypatch.setattr(orbit_main, "exchange_google_authorization_code", unavailable)

    with TestClient(orbit_main.app) as client:
        response = client.post(
            "/v1/auth/session",
            json={"authorization_code": "one-time-code", "code_verifier": "v" * 43},
        )

    assert response.status_code == 503
    assert response.json() == {"detail": "Agent authentication is unavailable."}


def test_auth_session_rejects_invalid_pkce_verifier_before_exchange(monkeypatch) -> None:
    async def must_not_exchange(_: str, __: str) -> GoogleIdentity:
        pytest.fail("invalid PKCE material reached the Google exchange")

    monkeypatch.setattr(orbit_main, "exchange_google_authorization_code", must_not_exchange)
    with TestClient(orbit_main.app) as client:
        response = client.post(
            "/v1/auth/session",
            json={"authorization_code": "one-time-code", "code_verifier": "too-short"},
        )

    assert response.status_code == 422
