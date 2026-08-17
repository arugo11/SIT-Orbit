import json
from pathlib import Path

import orbit_api.main as orbit_main
from fastapi.testclient import TestClient
from orbit_api.main import app

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
