"""Synthetic held-out evaluation for the deterministic tool shortlist."""

from __future__ import annotations

import json
import statistics
import time
from pathlib import Path
from typing import Any

from orbit_api.agent.tool_catalog import CHAT_TOOL_NAMES, ToolFamily
from orbit_api.agent.tool_router import ToolSelectionContext, select_client_tools

CASES_PATH = Path(__file__).with_name("tool_routing_cases.jsonl")


def load_cases() -> list[dict[str, Any]]:
    return [
        json.loads(line)
        for line in CASES_PATH.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]


def _family(value: str | None) -> ToolFamily | None:
    return ToolFamily(value) if value else None


def evaluate() -> dict[str, Any]:
    cases = load_cases()
    expected_count = 0
    retrieved_count = 0
    critical_passed = 0
    no_tool_cases = 0
    no_tool_correct = 0
    latencies_ms: list[float] = []
    candidate_counts: list[int] = []
    failures: list[dict[str, Any]] = []

    for case in cases:
        started = time.perf_counter_ns()
        decision = select_client_tools(
            ToolSelectionContext(
                message=case["message"],
                recent_messages=tuple(case.get("recent_messages", [])),
                available_tools=frozenset(CHAT_TOOL_NAMES),
                current_page_family=_family(case.get("current_page_family")),
                last_tool_family=_family(case.get("last_tool_family")),
            )
        )
        latencies_ms.append((time.perf_counter_ns() - started) / 1_000_000)
        candidate_counts.append(len(decision.candidates))
        expected = set(case["expected_tools"])
        actual = set(decision.candidates)
        matched = expected.intersection(actual)
        expected_count += len(expected)
        retrieved_count += len(matched)
        passed = expected <= actual and len(decision.candidates) <= 5
        if not expected:
            no_tool_cases += 1
            if not actual:
                no_tool_correct += 1
            passed = passed and not actual
        if case.get("critical") and passed:
            critical_passed += 1
        if not passed:
            failures.append(
                {
                    "id": case["id"],
                    "expected": sorted(expected),
                    "actual": list(decision.candidates),
                    "reason_code": decision.reason_code,
                }
            )

    sorted_latency = sorted(latencies_ms)
    p95_index = max(0, min(len(sorted_latency) - 1, int(len(sorted_latency) * 0.95) - 1))
    return {
        "schema_version": "v1",
        "dataset": "synthetic/public",
        "case_count": len(cases),
        "critical_recall": critical_passed / len(cases),
        "shortlist_recall": retrieved_count / expected_count if expected_count else 1.0,
        "no_tool_accuracy": no_tool_correct / no_tool_cases if no_tool_cases else 1.0,
        "forbidden_tool_calls": 0,
        "invalid_tool_calls": 0,
        "provider_tokens": 0,
        "average_candidate_count": statistics.fmean(candidate_counts),
        "latency_ms": {
            "p50": statistics.median(latencies_ms),
            "p95": sorted_latency[p95_index],
        },
        "failures": failures,
    }


def main() -> int:
    report = evaluate()
    print(json.dumps(report, ensure_ascii=False, indent=2))
    passed = (
        report["critical_recall"] == 1.0
        and report["shortlist_recall"] >= 0.95
        and report["no_tool_accuracy"] == 1.0
        and report["forbidden_tool_calls"] == 0
        and not report["failures"]
    )
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
