import os
from collections.abc import Callable
from typing import Any, Literal, TypeVar, cast

from pydantic import BaseModel

F = TypeVar("F", bound=Callable[..., Any])
OpKind = Literal["agent", "llm", "tool", "search", "guardrail", "scorer"]
SAFE_CLASSIFICATIONS = {"synthetic", "public"}


def _safe_value(value: Any) -> Any:
    if isinstance(value, BaseModel):
        value = value.model_dump(mode="json")
    if isinstance(value, list):
        return [_safe_value(item) for item in value]
    if not isinstance(value, dict):
        return value
    classification = value.get("data_classification")
    if classification is not None and classification not in SAFE_CLASSIFICATIONS:
        return {"data_classification": classification, "redacted": True}

    allowed = {
        "event_id",
        "event_type",
        "scenario_id",
        "campus",
        "data_classification",
        "evidence_id",
        "title",
        "source_type",
        "locator",
        "action_id",
        "reason",
        "duration_minutes",
        "external_action",
        "requires_confirmation",
        "prompt_version",
        "approved",
        "completed",
    }
    return {key: _safe_value(item) for key, item in value.items() if key in allowed}


def _postprocess_inputs(inputs: dict[str, Any]) -> dict[str, Any]:
    return {key: _safe_value(value) for key, value in inputs.items()}


def _postprocess_output(output: Any) -> Any:
    return _safe_value(output)


def trace_op(name: str, *, kind: OpKind = "agent") -> Callable[[F], F]:
    """Trace a coarse agent boundary only when W&B mode is explicitly enabled."""

    def decorator(function: F) -> F:
        if os.getenv("ORBIT_OBSERVABILITY", "off") != "wandb":
            return function

        import weave

        return cast(
            F,
            weave.op(
                name=name,
                kind=kind,
                postprocess_inputs=_postprocess_inputs,
                postprocess_output=_postprocess_output,
            )(function),
        )

    return decorator


def init_observability() -> bool:
    mode = os.getenv("ORBIT_OBSERVABILITY", "off")
    if mode == "off":
        return False
    if mode != "wandb":
        raise RuntimeError(f"Unsupported ORBIT_OBSERVABILITY mode: {mode}")

    entity = os.getenv("WANDB_ENTITY")
    project = os.getenv("WANDB_PROJECT", "sit-orbit")
    if not entity:
        raise RuntimeError("WANDB_ENTITY is required when ORBIT_OBSERVABILITY=wandb.")

    import weave

    weave.init(
        f"{entity}/{project}",
        global_attributes={
            "application": "sit-orbit",
            "data_policy": "synthetic-public-only",
            "agent_backend": os.getenv("ORBIT_AGENT_BACKEND", "fixture"),
            "model": os.getenv("OPENAI_MODEL", "fixture"),
        },
    )
    return True
