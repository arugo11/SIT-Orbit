from evals.run_book_discovery_eval import evaluate


def test_multi_query_release_gate() -> None:
    result = evaluate()

    assert result["passed"] is True
    assert result["relative_gain"] >= 0.10
    assert all(not item["unknown_candidates"] for item in result["cases"])
