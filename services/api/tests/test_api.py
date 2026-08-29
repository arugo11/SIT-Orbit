import json
from pathlib import Path

import orbit_api.main as orbit_main
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from orbit_api.main import app, configure_cors

ROOT = Path(__file__).resolve().parents[3]


def load_fixture(name: str):
    return json.loads((ROOT / "fixtures" / "b1_omiya" / name).read_text(encoding="utf-8"))


def test_health() -> None:
    with TestClient(app) as client:
        response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_health_does_not_require_backend_configuration(monkeypatch) -> None:
    monkeypatch.setenv("ORBIT_AGENT_BACKEND", "azure_openai")
    monkeypatch.delenv("AZURE_OPENAI_API_KEY", raising=False)
    monkeypatch.delenv("AZURE_OPENAI_ENDPOINT", raising=False)
    monkeypatch.delenv("AZURE_OPENAI_MODEL", raising=False)

    with TestClient(app) as client:
        response = client.get("/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


@pytest.mark.parametrize(
    ("backend", "allowed"),
    [("fixture", False), ("openai", False), ("azure_openai", True)],
)
def test_capabilities_report_the_configured_personal_data_boundary(
    monkeypatch,
    backend: str,
    allowed: bool,
) -> None:
    monkeypatch.delenv("ORBIT_API_TOKEN", raising=False)
    monkeypatch.setenv("ORBIT_AGENT_BACKEND", backend)
    with TestClient(app) as client:
        response = client.get("/v1/capabilities")

    assert response.status_code == 200
    assert response.json() == {
        "agent_backend": backend,
        "my_library_personal_context": allowed,
    }


@pytest.mark.parametrize(
    ("backend", "mode", "observability", "live_tools"),
    [
        ("fixture", "off", "off", False),
        ("azure_openai", "fixture", "off", False),
        ("azure_openai", "live", "wandb", False),
        ("azure_openai", "live", "off", True),
    ],
)
def test_chat_capabilities_gate_live_scombz_tools(
    monkeypatch,
    backend: str,
    mode: str,
    observability: str,
    live_tools: bool,
) -> None:
    monkeypatch.delenv("ORBIT_API_TOKEN", raising=False)
    monkeypatch.setenv("ORBIT_AGENT_BACKEND", backend)
    monkeypatch.setenv("ORBIT_SCOMBZ_STUDENT_READ", mode)
    monkeypatch.setenv("ORBIT_OBSERVABILITY", observability)
    if observability == "wandb":
        monkeypatch.setattr(orbit_main, "init_observability", lambda: False)
    with TestClient(app) as client:
        response = client.get("/v1/chat/capabilities")
    assert response.status_code == 200
    body = response.json()
    assert body["schema_version"] == "v1"
    assert body["max_client_tools"] == 32
    names = set(body["supported_client_tools"])
    live_names = {
        "scombz_course_list",
        "scombz_portal_read",
        "scombz_course_read",
        "scombz_material_search",
    }
    assert bool(names & live_names) is live_tools


def test_api_token_protects_v1_routes_but_not_health(monkeypatch) -> None:
    monkeypatch.setenv("ORBIT_API_TOKEN", "test-agent-token")
    monkeypatch.setenv("ORBIT_AGENT_BACKEND", "fixture")
    request = {"event": load_fixture("event.json"), "context": load_fixture("context.json")}

    with TestClient(app) as client:
        assert client.get("/health").status_code == 200
        missing = client.post("/v1/actions/propose", json=request)
        wrong = client.post(
            "/v1/actions/propose",
            json=request,
            headers={"Authorization": "Bearer wrong-token"},
        )
        accepted = client.post(
            "/v1/actions/propose",
            json=request,
            headers={"Authorization": "Bearer test-agent-token"},
        )

    assert missing.status_code == 401
    assert missing.headers["www-authenticate"] == "Bearer"
    assert wrong.status_code == 401
    assert accepted.status_code == 200


def test_chat_capabilities_requires_the_same_authenticated_session(monkeypatch) -> None:
    monkeypatch.setenv("ORBIT_API_TOKEN", "test-chat-capability-token")
    monkeypatch.setenv("ORBIT_AGENT_BACKEND", "azure_openai")
    monkeypatch.setenv("ORBIT_SCOMBZ_STUDENT_READ", "live")
    monkeypatch.setenv("ORBIT_OBSERVABILITY", "off")
    with TestClient(app) as client:
        assert client.get("/v1/chat/capabilities").status_code == 401
        response = client.get(
            "/v1/chat/capabilities",
            headers={"Authorization": "Bearer test-chat-capability-token"},
        )
    assert response.status_code == 200
    assert response.json()["scombz_student_read_mode"] == "live"


def test_configured_extension_origin_can_complete_cors_preflight(monkeypatch) -> None:
    origin = "chrome-extension://onlkblmignmbeaogocmhgkiecmdlihci"
    monkeypatch.setenv("ORBIT_CORS_ORIGINS", origin)
    cors_app = FastAPI()
    configure_cors(cors_app)

    @cors_app.post("/v1/chat/runs")
    async def chat_run() -> dict[str, str]:
        return {"status": "ok"}

    with TestClient(cors_app) as client:
        response = client.options(
            "/v1/chat/runs",
            headers={
                "Origin": origin,
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": (
                    "authorization,content-type,x-orbit-tool-call-id,x-orbit-evidence-id"
                ),
            },
        )
        actual = client.post(
            "/v1/chat/runs",
            headers={"Origin": origin},
        )

    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == origin
    allowed_headers = response.headers["access-control-allow-headers"]
    assert "Authorization" in allowed_headers
    assert "Content-Type" in allowed_headers
    assert "X-Orbit-Tool-Call-Id" in allowed_headers
    assert "X-Orbit-Evidence-Id" in allowed_headers

    assert actual.status_code == 200
    exposed = actual.headers.get("access-control-expose-headers", "")
    assert "X-Orbit-Evidence-Id" in exposed
    assert "X-Orbit-Tool-Call-Id" in exposed


def test_unconfigured_origin_is_not_allowed_by_cors(monkeypatch) -> None:
    allowed = "chrome-extension://onlkblmignmbeaogocmhgkiecmdlihci"
    monkeypatch.setenv("ORBIT_CORS_ORIGINS", allowed)
    cors_app = FastAPI()
    configure_cors(cors_app)

    with TestClient(cors_app) as client:
        response = client.options(
            "/v1/chat/runs",
            headers={
                "Origin": "https://untrusted.example",
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "authorization,content-type",
            },
        )

    assert response.status_code == 400
    assert "access-control-allow-origin" not in response.headers


def test_cors_rejects_wildcard_origin(monkeypatch) -> None:
    monkeypatch.setenv("ORBIT_CORS_ORIGINS", "*")

    with pytest.raises(RuntimeError, match="explicit origins"):
        configure_cors(FastAPI())


def test_propose_and_verify_action(monkeypatch) -> None:
    monkeypatch.setenv("ORBIT_AGENT_BACKEND", "fixture")
    monkeypatch.setenv("ORBIT_OBSERVABILITY", "off")

    with TestClient(app) as client:
        proposal_response = client.post(
            "/v1/actions/propose",
            json={"event": load_fixture("event.json"), "context": load_fixture("context.json")},
        )
        assert proposal_response.status_code == 200
        proposal = proposal_response.json()
        assert proposal["evidence"]

        verify_response = client.post(
            f"/v1/actions/{proposal['action_id']}/verify",
            json={
                "scenario_id": "b1-omiya-calculus",
                "campus": "omiya",
                "approved": True,
                "completed": True,
                "notes": "Synthetic fixture completed.",
            },
        )
    assert verify_response.status_code == 200
    assert verify_response.json()["event_type"] == "action_completed"


def test_unknown_run_returns_gone_without_model_configuration() -> None:
    with TestClient(app) as client:
        response = client.post(
            "/v1/agent/runs/run-does-not-exist/tool-results",
            json={
                "tool_call_id": "calendar-call-1",
                "result": {
                    "schema_version": "v1",
                    "status": "known",
                    "time_zone": "Asia/Tokyo",
                    "window_start": "2026-08-17T00:00:00+09:00",
                    "window_end": "2026-08-24T00:00:00+09:00",
                    "available_minutes": 10080,
                    "busy_minutes": 0,
                    "free_intervals": [],
                    "reason_code": None,
                },
            },
        )

    assert response.status_code == 410
    assert response.json() == {"detail": "Agent run is no longer resumable."}


def test_calendar_event_details_and_oauth_tokens_are_rejected_before_model_call(
    monkeypatch,
) -> None:
    class SpyRunService:
        called = False
        store = type("Store", (), {"clear": lambda self: None})()

        async def submit_tool_result(self, run_id, request):
            self.called = True
            raise AssertionError("Malformed Calendar results must not reach the model.")

    spy = SpyRunService()
    monkeypatch.setattr(orbit_main, "agent_run_service", spy)
    result = {
        "schema_version": "v1",
        "status": "known",
        "time_zone": "Asia/Tokyo",
        "window_start": "2026-08-17T00:00:00+09:00",
        "window_end": "2026-08-24T00:00:00+09:00",
        "available_minutes": 10080,
        "busy_minutes": 0,
        "free_intervals": [],
        "reason_code": None,
        "title": "private event title",
        "event_id": "private-event-id",
        "oauth_token": "oauth-secret",
    }

    with TestClient(app) as client:
        response = client.post(
            "/v1/agent/runs/run-with-invalid-result/tool-results",
            json={"tool_call_id": "calendar-call-1", "result": result},
        )

    assert response.status_code == 422
    assert spy.called is False
