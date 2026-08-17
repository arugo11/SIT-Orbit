import pydantic_ai.models
import pytest


@pytest.fixture(autouse=True)
def disable_real_model_requests(monkeypatch: pytest.MonkeyPatch) -> None:
    """Keep every API test on local test doubles, never a provider network."""

    monkeypatch.setattr(pydantic_ai.models, "ALLOW_MODEL_REQUESTS", False)
