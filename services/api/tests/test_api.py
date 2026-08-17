import json
from pathlib import Path

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
