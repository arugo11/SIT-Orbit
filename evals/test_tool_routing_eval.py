import pytest
from orbit_api.agent.native_tool_search import (
    TOOL_ADDITION_MODE,
    TOOL_DEFERRAL_MODE,
    build_native_tool_search_profile,
)
from orbit_api.agent.tool_catalog import CHAT_TOOL_NAMES

from evals.run_tool_routing_eval import (
    evaluate,
    evaluate_observations,
    load_cases,
    validate_live_configuration,
)


def test_native_eval_is_skipped_without_explicit_azure_opt_in(monkeypatch) -> None:
    monkeypatch.delenv("ORBIT_ENABLE_AZURE_EVAL", raising=False)
    report = evaluate()
    assert report["status"] == "skipped"
    assert report["case_count"] >= 20
    assert report["expected_client_tool_count"] == len(CHAT_TOOL_NAMES)


def test_case_manifest_is_labels_only() -> None:
    cases = load_cases()
    assert len(cases) >= 20
    assert all(
        case["expected_tools"] == list(dict.fromkeys(case["expected_tools"]))
        for case in cases
    )


def test_observation_scoring_uses_provider_tool_names() -> None:
    cases = [
        {"id": "answer", "message": "synthetic", "expected_tools": ["cast_search"]},
        {"id": "general", "message": "synthetic", "expected_tools": []},
    ]
    report = evaluate_observations(
        [
            {
                "id": "answer",
                "discovered_tools": ["cast_search"],
                "executed_tools": ["cast_search"],
            },
            {"id": "general", "discovered_tools": [], "executed_tools": [], "data_read_calls": 0},
        ],
        cases=cases,
    )
    assert report["metrics"]["tool_selection_recall"] == 1.0
    assert report["metrics"]["unnecessary_tool_rate"] == 0.0
    assert report["failures"] == []


def test_native_profile_declares_responses_modes() -> None:
    profile = build_native_tool_search_profile("gpt-5.6-terra")
    assert profile.get("tool_deferral_mode") == TOOL_DEFERRAL_MODE
    assert profile.get("tool_addition_mode") == TOOL_ADDITION_MODE


def test_azure_eval_requires_the_canonical_deployment_pair() -> None:
    with pytest.raises(RuntimeError, match="AZURE_OPENAI_MODEL"):
        validate_live_configuration(
            {
                "AZURE_OPENAI_API_KEY": "synthetic-key",
                "AZURE_OPENAI_ENDPOINT": "https://example.openai.azure.com",
                "AZURE_OPENAI_BASE_MODEL": "gpt-5.6-terra",
                "ORBIT_OBSERVABILITY": "off",
            }
        )
