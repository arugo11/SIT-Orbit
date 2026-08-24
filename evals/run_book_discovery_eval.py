"""Offline release gate for multi-query related-book discovery."""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any

CASES_PATH = Path(__file__).with_name("book_discovery_cases.jsonl")


def load_cases() -> list[dict[str, Any]]:
    return [
        json.loads(line)
        for line in CASES_PATH.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]


def dcg(relevances: list[int], *, limit: int = 5) -> float:
    return sum(
        (2**relevance - 1) / math.log2(rank + 1)
        for rank, relevance in enumerate(relevances[:limit], start=1)
    )


def ndcg_at_five(ranking: list[str], allowed: dict[str, dict[str, Any]]) -> float:
    relevances = [int(allowed[item]["relevance"]) for item in ranking if item in allowed]
    ideal = sorted(
        (int(item["relevance"]) for item in allowed.values()),
        reverse=True,
    )
    ideal_dcg = dcg(ideal)
    return dcg(relevances) / ideal_dcg if ideal_dcg else 0.0


def evaluate() -> dict[str, Any]:
    rows: list[dict[str, Any]] = []
    for case in load_cases():
        allowed = case["allowed_candidates"]
        baseline = case["baseline"]
        multi_query = case["multi_query"]
        unknown = [item for item in multi_query if item not in allowed]
        top = [allowed[item] for item in multi_query[:5] if item in allowed]
        rows.append(
            {
                "case_id": case["case_id"],
                "baseline_ndcg_at_5": ndcg_at_five(baseline, allowed),
                "multi_query_ndcg_at_5": ndcg_at_five(multi_query, allowed),
                "unknown_candidates": unknown,
                "author_count": len({item["author"] for item in top}),
                "axis_count": len(
                    {axis for item in top for axis in item.get("axes", [])}
                ),
            }
        )
    baseline_mean = sum(item["baseline_ndcg_at_5"] for item in rows) / len(rows)
    multi_query_mean = sum(item["multi_query_ndcg_at_5"] for item in rows) / len(rows)
    relative_gain = (
        (multi_query_mean - baseline_mean) / baseline_mean if baseline_mean else 0.0
    )
    passed = (
        relative_gain >= 0.10
        and all(not item["unknown_candidates"] for item in rows)
        and all(item["author_count"] >= 3 for item in rows)
        and all(item["axis_count"] >= 2 for item in rows)
    )
    return {
        "baseline_mean_ndcg_at_5": baseline_mean,
        "multi_query_mean_ndcg_at_5": multi_query_mean,
        "relative_gain": relative_gain,
        "passed": passed,
        "cases": rows,
    }


def main() -> int:
    result = evaluate()
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
