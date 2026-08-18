from __future__ import annotations

from copy import deepcopy

import pytest
from orbit_api.models import ActionProposal, CalendarAvailabilityResult, EvidenceLink
from pydantic_ai.exceptions import UnexpectedModelBehavior
from pydantic_ai.usage import RunUsage

from evals.run_model_selection import (
    CASES_PATH,
    DeferredActionRun,
    UsageCollector,
    evaluate_case,
    load_cases,
    main,
    parse_role_mappings,
    run_live,
    validate_live_configuration,
)


def _proposal(
    context: list[EvidenceLink],
    case_id: str,
    required_evidence_ids: list[str] | None = None,
) -> ActionProposal:
    required = {
        item.evidence_id for item in context if item.evidence_id in (required_evidence_ids or [])
    }
    evidence = [item for item in context if item.evidence_id in required]
    evidence.extend(item for item in context if item.source_type == "calendar")
    evidence = evidence or context[:1]
    return ActionProposal(
        action_id=f"act-test-{case_id}",
        title="根拠を確認する",
        reason="入力された根拠に基づく合成評価です。",
        duration_minutes=5,
        evidence=evidence,
        external_action="none",
        requires_confirmation=True,
        prompt_version="test",
    )


class FakeBackend:
    def __init__(self, usage_callback, cases_by_scenario):
        self.usage_callback = usage_callback
        self.cases_by_scenario = cases_by_scenario

    async def start_run(self, event, context, *, calendar_connected):
        self.usage_callback(RunUsage(requests=1, input_tokens=10, output_tokens=5))
        case = self.cases_by_scenario[event.scenario_id]
        if case["expected_tool"] == "required":
            return None, DeferredActionRun(
                messages=[],
                tool_call_id="calendar-call",
                conversation_id="test",
            )
        return _proposal(context, case["case_id"], case.get("required_evidence_ids")), None

    async def resume_run(
        self,
        event,
        context,
        deferred,
        calendar_result: CalendarAvailabilityResult,
    ):
        assert deferred.tool_call_id == "calendar-call"
        assert calendar_result.status == "known"
        self.usage_callback(RunUsage(requests=1, input_tokens=20, output_tokens=8))
        case = self.cases_by_scenario[event.scenario_id]
        return _proposal(context, case["case_id"], case.get("required_evidence_ids"))


def test_model_selection_cases_are_exactly_sixteen() -> None:
    cases = load_cases(CASES_PATH)
    assert len(cases) == 16
    assert len({case["case_id"] for case in cases}) == 16


def test_live_configuration_fails_closed_without_credentials() -> None:
    with pytest.raises(RuntimeError, match="AZURE_OPENAI_API_KEY"):
        validate_live_configuration(
            {"terra": "terra-deployment"},
            {
                "ORBIT_OBSERVABILITY": "off",
                "AZURE_OPENAI_ENDPOINT": "https://example.openai.azure.com",
            },
        )


@pytest.mark.asyncio
async def test_run_live_rejects_non_sixteen_cases_before_backend_construction(monkeypatch) -> None:
    monkeypatch.setenv("AZURE_OPENAI_API_KEY", "synthetic-test-key")
    monkeypatch.setenv("AZURE_OPENAI_ENDPOINT", "https://example.openai.azure.com")
    monkeypatch.setenv("ORBIT_OBSERVABILITY", "off")
    constructed = False

    def factory(_deployment, _callback):
        nonlocal constructed
        constructed = True
        raise AssertionError("the live backend must not be constructed for an invalid case set")

    with pytest.raises(ValueError, match="exactly 16"):
        await run_live(
            {"terra": "terra-deployment"},
            cases=load_cases()[:-1],
            backend_factory=factory,
        )

    assert constructed is False


@pytest.mark.asyncio
async def test_run_live_rejects_personal_case_data_before_backend_construction(monkeypatch) -> None:
    monkeypatch.setenv("AZURE_OPENAI_API_KEY", "synthetic-test-key")
    monkeypatch.setenv("AZURE_OPENAI_ENDPOINT", "https://example.openai.azure.com")
    monkeypatch.setenv("ORBIT_OBSERVABILITY", "off")
    cases = deepcopy(load_cases())
    cases[0]["event"]["data_classification"] = "personal"
    constructed = False

    def factory(_deployment, _callback):
        nonlocal constructed
        constructed = True
        raise AssertionError("personal cases must be rejected before provider construction")

    with pytest.raises(ValueError, match="synthetic or public"):
        await run_live(
            {"terra": "terra-deployment"},
            cases=cases,
            backend_factory=factory,
        )

    assert constructed is False


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("environment", "message"),
    [
        (
            {"AZURE_OPENAI_ENDPOINT": "https://example.openai.azure.com"},
            "AZURE_OPENAI_API_KEY",
        ),
        (
            {"AZURE_OPENAI_API_KEY": "synthetic-test-key"},
            "AZURE_OPENAI_ENDPOINT",
        ),
    ],
)
async def test_run_live_validates_provider_configuration_before_factory(
    monkeypatch,
    environment: dict[str, str],
    message: str,
) -> None:
    monkeypatch.setenv("ORBIT_OBSERVABILITY", "off")
    monkeypatch.delenv("AZURE_OPENAI_API_KEY", raising=False)
    monkeypatch.delenv("AZURE_OPENAI_ENDPOINT", raising=False)
    for key, value in environment.items():
        monkeypatch.setenv(key, value)
    constructed = False

    def factory(_deployment, _callback):
        nonlocal constructed
        constructed = True
        raise AssertionError("provider construction must be gated by live configuration")

    with pytest.raises(RuntimeError, match=message):
        await run_live(
            {"terra": "terra-deployment"},
            cases=load_cases(),
            backend_factory=factory,
        )

    assert constructed is False


@pytest.mark.asyncio
async def test_run_live_rejects_non_off_observability_before_factory(monkeypatch) -> None:
    monkeypatch.setenv("AZURE_OPENAI_API_KEY", "synthetic-test-key")
    monkeypatch.setenv("AZURE_OPENAI_ENDPOINT", "https://example.openai.azure.com")
    monkeypatch.setenv("ORBIT_OBSERVABILITY", "wandb")
    constructed = False

    def factory(_deployment, _callback):
        nonlocal constructed
        constructed = True
        raise AssertionError("W&B must not be enabled for live model selection")

    with pytest.raises(RuntimeError, match="ORBIT_OBSERVABILITY=off"):
        await run_live(
            {"terra": "terra-deployment"},
            cases=load_cases(),
            backend_factory=factory,
        )

    assert constructed is False


def test_role_mapping_is_explicit_and_repeatable() -> None:
    assert parse_role_mappings(["sol=quality", "terra=balanced"]) == {
        "sol": "quality",
        "terra": "balanced",
    }
    with pytest.raises(ValueError, match="duplicated"):
        parse_role_mappings(["terra=one", "terra=two"])


@pytest.mark.asyncio
async def test_unexpected_calendar_tool_is_categorized_as_hard_failure() -> None:
    class UnexpectedToolBackend(FakeBackend):
        async def start_run(self, event, context, *, calendar_connected):
            self.usage_callback(RunUsage(requests=1, input_tokens=10, output_tokens=5))
            return None, DeferredActionRun(
                messages=[],
                tool_call_id="unexpected",
                conversation_id="test",
            )

    case = load_cases()[0]
    collector = UsageCollector()
    result = await evaluate_case(
        UnexpectedToolBackend(collector.callback, {case["event"]["scenario_id"]: case}),
        case,
        role="terra",
        usage_collector=collector,
        clock=lambda: 1.0,
    )
    assert result["status"] == "failed"
    assert result["failure_category"] == "calendar_tool_behavior"


@pytest.mark.asyncio
async def test_missing_required_calendar_tool_is_categorized_as_hard_failure() -> None:
    class MissingToolBackend(FakeBackend):
        async def start_run(self, event, context, *, calendar_connected):
            self.usage_callback(RunUsage(requests=1, input_tokens=10, output_tokens=5))
            case = self.cases_by_scenario[event.scenario_id]
            return _proposal(context, case["case_id"]), None

    case = next(case for case in load_cases() if case["expected_tool"] == "required")
    collector = UsageCollector()
    result = await evaluate_case(
        MissingToolBackend(collector.callback, {case["event"]["scenario_id"]: case}),
        case,
        role="terra",
        usage_collector=collector,
        clock=lambda: 1.0,
    )

    assert result["status"] == "failed"
    assert result["failure_category"] == "calendar_tool_behavior"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "error_message",
    [
        "Exactly one deferred external tool call is allowed per run.",
        "The agent requested an unsupported calendar tool call.",
    ],
)
async def test_multiple_or_unsupported_calendar_tool_is_hard_failure(error_message: str) -> None:
    class InvalidToolBackend(FakeBackend):
        async def start_run(self, event, context, *, calendar_connected):
            raise RuntimeError(error_message)

    case = next(case for case in load_cases() if case["expected_tool"] == "required")
    collector = UsageCollector()
    result = await evaluate_case(
        InvalidToolBackend(collector.callback, {case["event"]["scenario_id"]: case}),
        case,
        role="terra",
        usage_collector=collector,
        clock=lambda: 1.0,
    )

    assert result["status"] == "failed"
    assert result["failure_category"] == "calendar_tool_behavior"


@pytest.mark.asyncio
async def test_unknown_evidence_id_is_a_hard_failure_in_model_selection_report() -> None:
    class UnknownEvidenceBackend(FakeBackend):
        async def start_run(self, event, context, *, calendar_connected):
            self.usage_callback(RunUsage(requests=1, input_tokens=10, output_tokens=5))
            proposal = _proposal(context, self.cases_by_scenario[event.scenario_id]["case_id"])
            proposal = proposal.model_copy(
                update={
                    "evidence": [
                        EvidenceLink(
                            evidence_id="ev-not-supplied",
                            title="未知の根拠",
                            source_type="assignment",
                            locator="demo://unknown",
                            data_classification="synthetic",
                        )
                    ]
                }
            )
            return proposal, None

    case = load_cases()[0]
    collector = UsageCollector()
    result = await evaluate_case(
        UnknownEvidenceBackend(collector.callback, {case["event"]["scenario_id"]: case}),
        case,
        role="terra",
        usage_collector=collector,
        clock=lambda: 1.0,
    )

    assert result["status"] == "failed"
    assert result["failure_category"] == "unknown_evidence_id"


@pytest.mark.asyncio
async def test_duplicate_evidence_id_is_a_hard_failure_in_model_selection_report() -> None:
    class DuplicateEvidenceBackend(FakeBackend):
        async def start_run(self, event, context, *, calendar_connected):
            self.usage_callback(RunUsage(requests=1, input_tokens=10, output_tokens=5))
            evidence = context[0]
            proposal = ActionProposal.model_construct(
                action_id="act-duplicate-evidence",
                title="根拠を確認する",
                reason="重複根拠の合成評価です。",
                duration_minutes=5,
                evidence=[evidence, evidence],
                external_action="none",
                requires_confirmation=True,
                prompt_version="test",
            )
            return proposal, None

    case = load_cases()[0]
    collector = UsageCollector()
    result = await evaluate_case(
        DuplicateEvidenceBackend(collector.callback, {case["event"]["scenario_id"]: case}),
        case,
        role="terra",
        usage_collector=collector,
        clock=lambda: 1.0,
    )

    assert result["status"] == "failed"


@pytest.mark.asyncio
async def test_structured_output_failure_is_a_hard_failure_in_model_selection_report() -> None:
    class StructuredOutputFailureBackend(FakeBackend):
        async def start_run(self, event, context, *, calendar_connected):
            raise UnexpectedModelBehavior("invalid structured output")

    case = load_cases()[0]
    collector = UsageCollector()
    result = await evaluate_case(
        StructuredOutputFailureBackend(collector.callback, {case["event"]["scenario_id"]: case}),
        case,
        role="terra",
        usage_collector=collector,
        clock=lambda: 1.0,
    )

    assert result["status"] == "failed"
    assert result["failure_category"] == "structured_output_failure"


@pytest.mark.asyncio
async def test_unsupported_fact_is_a_hard_failure_in_model_selection_report() -> None:
    class UnsupportedFactBackend(FakeBackend):
        async def start_run(self, event, context, *, calendar_connected):
            self.usage_callback(RunUsage(requests=1, input_tokens=10, output_tokens=5))
            proposal = _proposal(context, self.cases_by_scenario[event.scenario_id]["case_id"])
            proposal = proposal.model_copy(
                update={"reason": "8月20日に試験があり満点を目指します。"}
            )
            return proposal, None

    case = next(case for case in load_cases() if "8月20日" in case["forbidden_terms"])
    collector = UsageCollector()
    result = await evaluate_case(
        UnsupportedFactBackend(collector.callback, {case["event"]["scenario_id"]: case}),
        case,
        role="terra",
        usage_collector=collector,
        clock=lambda: 1.0,
    )

    assert result["status"] == "failed"
    assert result["failure_category"] == "unsupported_fact"


@pytest.mark.asyncio
async def test_confirmation_violation_is_a_hard_failure_in_model_selection_report() -> None:
    class ConfirmationViolationBackend(FakeBackend):
        async def start_run(self, event, context, *, calendar_connected):
            self.usage_callback(RunUsage(requests=1, input_tokens=10, output_tokens=5))
            proposal = ActionProposal.model_construct(
                action_id="act-unconfirmed-write",
                title="予定を登録する",
                reason="外部操作を自動で実行します。",
                duration_minutes=5,
                evidence=[context[0]],
                external_action="calendar_draft",
                requires_confirmation=False,
                prompt_version="test",
            )
            return proposal, None

    case = next(case for case in load_cases() if case["case_id"] == "confirmation-calendar-draft")
    collector = UsageCollector()
    result = await evaluate_case(
        ConfirmationViolationBackend(collector.callback, {case["event"]["scenario_id"]: case}),
        case,
        role="terra",
        usage_collector=collector,
        clock=lambda: 1.0,
    )

    assert result["status"] == "failed"
    assert result["failure_category"] == "confirmation_invariant"


@pytest.mark.asyncio
async def test_duration_exceeding_case_limit_is_a_hard_failure() -> None:
    class OverlongActionBackend(FakeBackend):
        async def start_run(self, event, context, *, calendar_connected):
            self.usage_callback(RunUsage(requests=1, input_tokens=10, output_tokens=5))
            case = self.cases_by_scenario[event.scenario_id]
            proposal = _proposal(context, case["case_id"])
            proposal = proposal.model_copy(
                update={"duration_minutes": case["max_duration_minutes"] + 1}
            )
            return proposal, None

    case = next(case for case in load_cases() if case["case_id"] == "direct-short-window")
    collector = UsageCollector()
    result = await evaluate_case(
        OverlongActionBackend(collector.callback, {case["event"]["scenario_id"]: case}),
        case,
        role="terra",
        usage_collector=collector,
        clock=lambda: 1.0,
    )

    assert result["status"] == "failed"
    assert result["failure_category"] == "duration_exceeds_window"


def test_invalid_structured_output_exception_is_a_hard_failure() -> None:
    from evals.run_model_selection import classify_exception

    assert (
        classify_exception(UnexpectedModelBehavior("invalid result"))
        == "structured_output_failure"
    )


@pytest.mark.asyncio
async def test_report_is_deterministic_and_aggregates_deferred_usage(monkeypatch) -> None:
    cases = load_cases()
    by_scenario = {case["event"]["scenario_id"]: case for case in cases}

    def factory(deployment, callback):
        assert deployment == "terra-deployment"
        return FakeBackend(callback, by_scenario)

    monkeypatch.setenv("AZURE_OPENAI_API_KEY", "synthetic-test-key")
    monkeypatch.setenv("AZURE_OPENAI_ENDPOINT", "https://example.openai.azure.com")
    monkeypatch.setenv("ORBIT_OBSERVABILITY", "off")
    first = await run_live(
        {"terra": "terra-deployment"},
        cases=cases,
        backend_factory=factory,
        clock=lambda: 1.0,
    )
    second = await run_live(
        {"terra": "terra-deployment"},
        cases=cases,
        backend_factory=factory,
        clock=lambda: 1.0,
    )

    assert first == second
    assert first["hard_failure_count"] == 0
    assert first["roles"][0]["usage"]["requests"] == 21
    assert first["roles"][0]["usage"]["input_tokens"] == 260
    assert first["roles"][0]["usage"]["output_tokens"] == 120
    assert first["roles"][0]["usage"]["cost_source"] == "estimate"
    assert first["roles"][0]["cases"][0]["proposal"]["title"] == "根拠を確認する"
    assert first["pricing_checked_on"] == "2026-08-19"
    assert first["selection_status"] == "manual_review_required"
    assert first["automated_grounding_scope"] == "case_defined_forbidden_terms_only"
    assert first["pricing_source"].startswith("https://")
    assert first["roles"][0]["cases"][0]["elapsed_ms"] == 0
    assert set(first["roles"][0]["cases"][0]["usage"]) == {
        "requests",
        "input_tokens",
        "output_tokens",
        "cache_read_tokens",
        "cache_write_tokens",
        "cost_usd",
        "cost_source",
    }
    assert set(first["roles"][0]["cases"][0]["proposal"]) == {
        "title",
        "reason",
        "duration_minutes",
        "evidence_ids",
        "external_action",
        "requires_confirmation",
        "prompt_version",
    }


def test_cli_without_credentials_returns_blocked_exit(monkeypatch, capsys) -> None:
    monkeypatch.delenv("AZURE_OPENAI_API_KEY", raising=False)
    monkeypatch.delenv("AZURE_OPENAI_ENDPOINT", raising=False)
    monkeypatch.setenv("ORBIT_OBSERVABILITY", "off")

    assert main(["--role", "terra=terra-deployment"]) == 2
    assert "blocked" in capsys.readouterr().err


def test_cli_returns_nonzero_when_report_contains_hard_failure(monkeypatch, capsys) -> None:
    async def fake_run_live(*_args, **_kwargs):
        return {
            "hard_failure_count": 1,
            "roles": [],
            "case_count": 16,
            "pricing_checked_on": "2026-08-19",
            "pricing_source": "https://example.invalid/pricing",
            "version": 1,
        }

    monkeypatch.setenv("AZURE_OPENAI_API_KEY", "synthetic-test-key")
    monkeypatch.setenv("AZURE_OPENAI_ENDPOINT", "https://example.openai.azure.com")
    monkeypatch.setenv("ORBIT_OBSERVABILITY", "off")
    monkeypatch.setattr("evals.run_model_selection.run_live", fake_run_live)

    assert main(["--role", "terra=terra-deployment"]) == 1
    assert '"hard_failure_count": 1' in capsys.readouterr().out
