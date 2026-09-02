"""Compare explicitly selected Azure deployments on the synthetic model cases.

This runner is intentionally separate from ``run_eval``.  The latter remains an
offline FixtureAgent check used by CI; this module is an explicitly requested,
live-provider command that fails closed unless its Azure configuration and data
policy requirements are present.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import time
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from decimal import Decimal
from pathlib import Path
from typing import Any, Protocol

from orbit_api.agent.azure_openai_backend import AzureOpenAIAgent
from orbit_api.agent.pydantic_ai_backend import DeferredActionRun
from orbit_api.models import (
    ActionProposal,
    CalendarAvailabilityInterval,
    CalendarAvailabilityResult,
    EvidenceLink,
    OrbitEvent,
)
from pydantic import ValidationError
from pydantic_ai.exceptions import UnexpectedModelBehavior
from pydantic_ai.usage import RunUsage

CASES_PATH = Path(__file__).with_name("model_selection_cases.jsonl")
ROLE_NAMES = ("terra", "luna", "sol")
ROLE_PRICES_USD_PER_MILLION: dict[str, tuple[Decimal, Decimal]] = {
    "terra": (Decimal("2"), Decimal("12")),
    "luna": (Decimal("0.20"), Decimal("1.20")),
    "sol": (Decimal("5"), Decimal("30")),
}
CALENDAR_WINDOW_START = "2026-08-19T00:00:00+09:00"
CALENDAR_WINDOW_END = "2026-08-26T00:00:00+09:00"


class AgentRunBackend(Protocol):
    async def start_run(
        self,
        event: OrbitEvent,
        context: list[EvidenceLink],
        *,
        calendar_connected: bool,
    ) -> tuple[ActionProposal | None, DeferredActionRun | None]: ...

    async def resume_run(
        self,
        event: OrbitEvent,
        context: list[EvidenceLink],
        deferred: DeferredActionRun,
        calendar_result: CalendarAvailabilityResult,
    ) -> ActionProposal: ...


BackendFactory = Callable[[str, Callable[[RunUsage], None]], AgentRunBackend]
Clock = Callable[[], float]


@dataclass
class UsageTotals:
    requests: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_tokens: int = 0
    cache_write_tokens: int = 0
    pydantic_cost_usd: Decimal = Decimal("0")
    has_pydantic_cost: bool = True

    def add(self, usage: RunUsage) -> None:
        self.requests += usage.requests
        self.input_tokens += usage.input_tokens
        self.output_tokens += usage.output_tokens
        self.cache_read_tokens += usage.cache_read_tokens
        self.cache_write_tokens += usage.cache_write_tokens
        if usage.cost is None:
            self.has_pydantic_cost = False
        else:
            self.pydantic_cost_usd += usage.cost

    def as_dict(self, role: str) -> dict[str, Any]:
        if self.requests == 0:
            cost_usd: float | None = None
            cost_source = "unknown"
        elif self.has_pydantic_cost:
            cost_usd = float(self.pydantic_cost_usd)
            cost_source = "pydantic_ai"
        else:
            input_price, output_price = ROLE_PRICES_USD_PER_MILLION[role]
            estimate = (
                Decimal(self.input_tokens) * input_price / Decimal(1_000_000)
                + Decimal(self.output_tokens) * output_price / Decimal(1_000_000)
            )
            cost_usd = float(estimate)
            cost_source = "estimate"
        return {
            "requests": self.requests,
            "input_tokens": self.input_tokens,
            "output_tokens": self.output_tokens,
            "cache_read_tokens": self.cache_read_tokens,
            "cache_write_tokens": self.cache_write_tokens,
            "cost_usd": cost_usd,
            "cost_source": cost_source,
        }


class UsageCollector:
    """Collect only aggregate usage; prompts, outputs, and credentials are not retained."""

    def __init__(self) -> None:
        self._active: list[RunUsage] | None = None

    def begin_case(self) -> list[RunUsage]:
        if self._active is not None:
            raise RuntimeError("A model selection case is already active.")
        self._active = []
        return self._active

    def end_case(self) -> None:
        self._active = None

    def callback(self, usage: RunUsage) -> None:
        if self._active is None:
            raise RuntimeError("Usage callback was invoked outside an active case.")
        self._active.append(usage)


def load_cases(path: Path = CASES_PATH) -> list[dict[str, Any]]:
    rows = [
        json.loads(line)
        for line in path.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    return validate_cases(rows)


def validate_cases(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Validate the complete live-evaluation dataset before any provider is built."""

    if any(not isinstance(row, dict) for row in rows):
        raise ValueError("Every model selection case must be a JSON object.")
    if len(rows) != 16:
        raise ValueError(f"Model selection cases must contain exactly 16 cases, got {len(rows)}.")
    case_ids = [row.get("case_id") for row in rows]
    if any(not isinstance(case_id, str) or not case_id for case_id in case_ids):
        raise ValueError("Every model selection case must have a non-empty case_id.")
    if len(set(case_ids)) != len(case_ids):
        raise ValueError("Model selection case IDs must be unique.")
    for row in rows:
        event = OrbitEvent.model_validate(row["event"])
        if event.data_classification not in {"synthetic", "public"}:
            raise ValueError("Model selection cases may contain only synthetic or public events.")
        context = [EvidenceLink.model_validate(item) for item in row["context"]]
        if any(item.data_classification not in {"synthetic", "public"} for item in context):
            raise ValueError("Model selection cases may contain only synthetic or public evidence.")
        if row.get("expected_tool") not in {"never", "required"}:
            raise ValueError(f"Unsupported expected_tool in {row['case_id']}.")
        if not isinstance(row.get("calendar_connected"), bool):
            raise ValueError(f"calendar_connected must be boolean in {row['case_id']}.")
        max_duration = row.get("max_duration_minutes")
        if not isinstance(max_duration, int) or not 1 <= max_duration <= 180:
            raise ValueError(
                f"max_duration_minutes must be an integer from 1 to 180 in {row['case_id']}."
            )
        forbidden_terms = row.get("forbidden_terms")
        if not isinstance(forbidden_terms, list) or any(
            not isinstance(term, str) or not term for term in forbidden_terms
        ):
            raise ValueError(f"forbidden_terms must be a list of strings in {row['case_id']}.")
    return rows


def parse_role_mappings(values: Sequence[str]) -> dict[str, str]:
    mappings: dict[str, str] = {}
    for value in values:
        role, separator, deployment = value.partition("=")
        if separator != "=" or role not in ROLE_NAMES or not deployment.strip():
            allowed = ", ".join(ROLE_NAMES)
            raise ValueError(
                f"Role mapping must be ROLE=DEPLOYMENT where ROLE is one of {allowed}."
            )
        if role in mappings:
            raise ValueError(f"Role mapping is duplicated: {role}.")
        mappings[role] = deployment.strip()
    if not mappings:
        raise ValueError("At least one --role ROLE=DEPLOYMENT mapping is required.")
    return mappings


def validate_live_configuration(
    role_mappings: dict[str, str], environ: dict[str, str] | None = None
) -> None:
    env = os.environ if environ is None else environ
    if not env.get("AZURE_OPENAI_API_KEY"):
        raise RuntimeError("AZURE_OPENAI_API_KEY is required for model selection evaluation.")
    if not env.get("AZURE_OPENAI_ENDPOINT"):
        raise RuntimeError("AZURE_OPENAI_ENDPOINT is required for model selection evaluation.")
    if env.get("ORBIT_OBSERVABILITY") != "off":
        raise RuntimeError("Model selection evaluation requires ORBIT_OBSERVABILITY=off.")
    for role in role_mappings:
        if role not in ROLE_PRICES_USD_PER_MILLION:
            raise RuntimeError(f"Unsupported model selection role: {role}.")


def synthetic_calendar_result() -> CalendarAvailabilityResult:
    return CalendarAvailabilityResult(
        status="known",
        time_zone="Asia/Tokyo",
        window_start=CALENDAR_WINDOW_START,
        window_end=CALENDAR_WINDOW_END,
        available_minutes=240,
        busy_minutes=240,
        free_intervals=[
            CalendarAvailabilityInterval(
                start="2026-08-19T09:00:00+09:00",
                end="2026-08-19T13:00:00+09:00",
            )
        ],
        reason_code="synthetic-model-selection",
    )


def calendar_evidence(case_id: str) -> EvidenceLink:
    return EvidenceLink(
        evidence_id=f"calendar-availability-v1-{case_id}",
        title="Google Calendarの空き時間",
        source_type="calendar",
        locator=f"orbit-calendar://availability/model-selection-{case_id}",
        data_classification="personal",
    )


def classify_exception(error: BaseException) -> str:
    message = str(error).casefold()
    if "unknown evidence" in message or "duplicate evidence" in message:
        return "unknown_evidence_id"
    if "calendar tool" in message or "deferred external tool" in message:
        return "calendar_tool_behavior"
    if (
        "plain response" in message
        or "structured output" in message
        or isinstance(error, ValidationError)
        or isinstance(error, UnexpectedModelBehavior)
    ):
        return "structured_output_failure"
    if "confirmation" in message:
        return "confirmation_invariant"
    if "allow_model_requests" in message:
        return "provider_request_blocked"
    return "provider_error"


def _failure_row(
    *,
    case_id: str,
    elapsed_ms: int,
    usage: UsageTotals,
    role: str,
    category: str,
    observed_tool: str,
    proposal: ActionProposal | None = None,
) -> dict[str, Any]:
    return {
        "case_id": case_id,
        "status": "failed",
        "observed_tool": observed_tool,
        "failure_category": category,
        "elapsed_ms": elapsed_ms,
        "usage": usage.as_dict(role),
        "proposal": _proposal_snapshot(proposal),
    }


def _proposal_snapshot(proposal: ActionProposal | None) -> dict[str, Any] | None:
    """Keep synthetic/public outputs reviewable without retaining prompts or credentials."""

    if proposal is None:
        return None
    return {
        "title": proposal.title,
        "reason": proposal.reason,
        "duration_minutes": proposal.duration_minutes,
        "evidence_ids": [item.evidence_id for item in proposal.evidence],
        "external_action": proposal.external_action,
        "requires_confirmation": proposal.requires_confirmation,
        "prompt_version": proposal.prompt_version,
    }


def _validate_proposal(
    case: dict[str, Any],
    event: OrbitEvent,
    context: list[EvidenceLink],
    proposal: ActionProposal,
) -> str | None:
    context_by_id = {item.evidence_id: item for item in context}
    evidence_id_list = [item.evidence_id for item in proposal.evidence]
    proposal_ids = set(evidence_id_list)
    if len(evidence_id_list) != len(proposal_ids):
        return "evidence_integrity"
    if any(item.evidence_id not in context_by_id for item in proposal.evidence):
        return "unknown_evidence_id"
    if any(required not in proposal_ids for required in case.get("required_evidence_ids", [])):
        return "evidence_integrity"
    if case.get("must_cite_calendar") and not any(
        item.source_type == "calendar" for item in proposal.evidence
    ):
        return "evidence_integrity"
    if proposal.external_action != "none" and not proposal.requires_confirmation:
        return "confirmation_invariant"
    if proposal.duration_minutes > case["max_duration_minutes"]:
        return "duration_exceeds_window"
    output_text = f"{proposal.title}\n{proposal.reason}".casefold()
    if any(str(term).casefold() in output_text for term in case.get("forbidden_terms", [])):
        return "unsupported_fact"
    del event
    return None


async def evaluate_case(
    backend: AgentRunBackend,
    case: dict[str, Any],
    *,
    role: str,
    usage_collector: UsageCollector,
    clock: Clock = time.perf_counter,
) -> dict[str, Any]:
    started = clock()
    case_id = str(case["case_id"])
    usage_rows = usage_collector.begin_case()
    observed_tool = "none"
    try:
        event = OrbitEvent.model_validate(case["event"])
        context = [EvidenceLink.model_validate(item) for item in case["context"]]
        proposal, deferred = await backend.start_run(
            event,
            context,
            calendar_connected=case["calendar_connected"],
        )
        if deferred is not None:
            observed_tool = "calendar"
            if case["expected_tool"] == "never":
                return _failure_row(
                    case_id=case_id,
                    elapsed_ms=int((clock() - started) * 1000),
                    usage=_sum_usage(usage_rows),
                    role=role,
                    category="calendar_tool_behavior",
                    observed_tool=observed_tool,
                )
            derived_evidence = calendar_evidence(case_id)
            proposal = await backend.resume_run(
                event,
                [*context, derived_evidence],
                deferred,
                synthetic_calendar_result(),
            )
        elif case["expected_tool"] == "required":
            return _failure_row(
                case_id=case_id,
                elapsed_ms=int((clock() - started) * 1000),
                usage=_sum_usage(usage_rows),
                role=role,
                category="calendar_tool_behavior",
                observed_tool=observed_tool,
            )

        if proposal is None:
            return _failure_row(
                case_id=case_id,
                elapsed_ms=int((clock() - started) * 1000),
                usage=_sum_usage(usage_rows),
                role=role,
                category="structured_output_failure",
                observed_tool=observed_tool,
            )
        final_context = [*context, calendar_evidence(case_id)] if deferred is not None else context
        failure_category = _validate_proposal(case, event, final_context, proposal)
        if failure_category is not None:
            return _failure_row(
                case_id=case_id,
                elapsed_ms=int((clock() - started) * 1000),
                usage=_sum_usage(usage_rows),
                role=role,
                category=failure_category,
                observed_tool=observed_tool,
                proposal=proposal,
            )
        return {
            "case_id": case_id,
            "status": "passed",
            "observed_tool": observed_tool,
            "failure_category": None,
            "elapsed_ms": int((clock() - started) * 1000),
            "usage": _sum_usage(usage_rows).as_dict(role),
            "proposal": _proposal_snapshot(proposal),
        }
    except Exception as error:
        return _failure_row(
            case_id=case_id,
            elapsed_ms=int((clock() - started) * 1000),
            usage=_sum_usage(usage_rows),
            role=role,
            category=classify_exception(error),
            observed_tool=observed_tool,
        )
    finally:
        usage_collector.end_case()


def _sum_usage(rows: Sequence[RunUsage]) -> UsageTotals:
    totals = UsageTotals()
    for row in rows:
        totals.add(row)
    return totals


def _default_backend_factory(
    deployment: str,
    usage_callback: Callable[[RunUsage], None],
) -> AgentRunBackend:
    return AzureOpenAIAgent(
        api_key=os.environ["AZURE_OPENAI_API_KEY"],
        model=deployment,
        endpoint=os.environ["AZURE_OPENAI_ENDPOINT"],
        # Model-selection evaluation belongs to the existing Action Agent
        # path.  It does not register Chat's deferred catalog and therefore
        # must not opt that path into Chat-only native Tool Search validation.
        native_tool_search_required=False,
        usage_callback=usage_callback,
    )


async def evaluate_role(
    role: str,
    deployment: str,
    cases: Sequence[dict[str, Any]],
    *,
    backend_factory: BackendFactory = _default_backend_factory,
    clock: Clock = time.perf_counter,
) -> dict[str, Any]:
    collector = UsageCollector()
    backend = backend_factory(deployment, collector.callback)
    rows = [
        await evaluate_case(
            backend,
            case,
            role=role,
            usage_collector=collector,
            clock=clock,
        )
        for case in cases
    ]
    totals = UsageTotals()
    for row in rows:
        usage = row["usage"]
        totals.requests += int(usage["requests"])
        totals.input_tokens += int(usage["input_tokens"])
        totals.output_tokens += int(usage["output_tokens"])
        totals.cache_read_tokens += int(usage["cache_read_tokens"])
        totals.cache_write_tokens += int(usage["cache_write_tokens"])
        if usage["cost_source"] == "pydantic_ai" and usage["cost_usd"] is not None:
            totals.pydantic_cost_usd += Decimal(str(usage["cost_usd"]))
        else:
            totals.has_pydantic_cost = False
    return {
        "role": role,
        "deployment": deployment,
        "case_count": len(rows),
        "hard_failure_count": sum(row["status"] == "failed" for row in rows),
        "usage": totals.as_dict(role),
        "cases": rows,
    }


async def run_live(
    role_mappings: dict[str, str],
    *,
    cases: Sequence[dict[str, Any]] | None = None,
    backend_factory: BackendFactory = _default_backend_factory,
    clock: Clock = time.perf_counter,
) -> dict[str, Any]:
    validate_live_configuration(role_mappings)
    selected_cases = load_cases() if cases is None else validate_cases(list(cases))
    roles = [
        await evaluate_role(
            role,
            role_mappings[role],
            selected_cases,
            backend_factory=backend_factory,
            clock=clock,
        )
        for role in sorted(role_mappings)
    ]
    return {
        "version": 1,
        "case_count": len(selected_cases),
        "hard_failure_count": sum(int(row["hard_failure_count"]) for row in roles),
        "selection_status": "manual_review_required",
        "automated_grounding_scope": "case_defined_forbidden_terms_only",
        "pricing_checked_on": "2026-08-19",
        "pricing_source": (
            "https://azure.microsoft.com/en-us/blog/"
            "gpt-5-6-now-available-in-microsoft-foundry/"
        ),
        "roles": roles,
    }


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Compare selected Azure deployments on 16 synthetic SIT ORBIT cases."
    )
    parser.add_argument(
        "--role",
        action="append",
        dest="roles",
        metavar="ROLE=DEPLOYMENT",
        help="Repeatable role mapping; ROLE is terra, luna, or sol.",
    )
    parser.add_argument(
        "--output",
        type=Path,
        help="Optional JSON report path. Without it, the report is printed only.",
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)
    try:
        mappings = parse_role_mappings(args.roles or [])
        report = asyncio.run(run_live(mappings))
    except (OSError, ValueError, RuntimeError) as error:
        print(
            json.dumps({"status": "blocked", "error": str(error)}, ensure_ascii=False),
            file=sys.stderr,
        )
        return 2

    serialized = json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True)
    print(serialized)
    if args.output is not None:
        try:
            args.output.write_text(serialized + "\n", encoding="utf-8")
        except OSError as error:
            print(
                json.dumps({"status": "blocked", "error": str(error)}, ensure_ascii=False),
                file=sys.stderr,
            )
            return 2
    return 1 if report["hard_failure_count"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
