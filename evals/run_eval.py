import argparse
import asyncio
import json
import os
from pathlib import Path
from typing import Any, cast

from orbit_api.agent.fixture import FixtureAgent
from orbit_api.models import EvidenceLink, OrbitEvent

from evals.scorers import SCORERS

CASES_PATH = Path(__file__).with_name("cases.jsonl")


def load_cases() -> list[dict[str, Any]]:
    return [
        json.loads(line)
        for line in CASES_PATH.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]


async def predict(event: dict[str, Any], context: list[dict[str, Any]]) -> dict[str, Any]:
    proposal = await FixtureAgent().propose_action(
        OrbitEvent.model_validate(event),
        [EvidenceLink.model_validate(item) for item in context],
    )
    return proposal.model_dump(mode="json")


async def run_local() -> int:
    results: list[dict[str, Any]] = []
    for case in load_cases():
        output = await predict(case["event"], case["context"])
        scores = {key: value for scorer in SCORERS for key, value in scorer(output).items()}
        results.append({"scenario_id": case["event"]["scenario_id"], "scores": scores})

    print(json.dumps(results, ensure_ascii=False, indent=2))
    return 0 if all(all(row["scores"].values()) for row in results) else 1


async def run_wandb() -> int:
    entity = os.getenv("WANDB_ENTITY")
    project = os.getenv("WANDB_PROJECT", "sit-orbit")
    if not entity:
        raise RuntimeError("WANDB_ENTITY is required for --wandb.")

    import weave

    weave.init(
        f"{entity}/{project}",
        global_attributes={"application": "sit-orbit", "dataset": "synthetic"},
    )
    traced_predict = weave.op(name="agent.fixture_eval", kind="agent")(predict)
    traced_scorers: list[Any] = [
        weave.op(name=f"scorer.{scorer.__name__}", kind="scorer")(scorer) for scorer in SCORERS
    ]
    # Weave accepts row dictionaries at runtime and converts them into a Table.
    dataset = weave.Dataset(name="sit-orbit-foundation", rows=cast(Any, load_cases()))
    evaluation = weave.Evaluation(dataset=dataset, scorers=traced_scorers)
    await evaluation.evaluate(traced_predict)
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Run the lightweight SIT ORBIT evaluation.")
    parser.add_argument(
        "--wandb",
        action="store_true",
        help="Send synthetic evaluation traces to W&B Weave.",
    )
    args = parser.parse_args()
    return asyncio.run(run_wandb() if args.wandb else run_local())


if __name__ == "__main__":
    raise SystemExit(main())
