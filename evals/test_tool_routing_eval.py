from evals.run_tool_routing_eval import evaluate, load_cases


def test_tool_routing_dataset_meets_release_gates() -> None:
    assert len(load_cases()) >= 20
    report = evaluate()
    assert report["critical_recall"] == 1.0
    assert report["shortlist_recall"] >= 0.95
    assert report["no_tool_accuracy"] == 1.0
    assert report["forbidden_tool_calls"] == 0
    assert report["invalid_tool_calls"] == 0
    assert report["provider_tokens"] == 0
    assert report["failures"] == []
