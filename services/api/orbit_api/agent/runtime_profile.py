"""Explicit runtime separation between production and deterministic demos."""

from __future__ import annotations

import os
from typing import Literal, cast

RuntimeProfile = Literal["development", "demo", "production"]


def runtime_profile() -> RuntimeProfile:
    value = os.getenv("ORBIT_RUNTIME_PROFILE", "development")
    if value not in {"development", "demo", "production"}:
        raise RuntimeError(f"Unsupported ORBIT_RUNTIME_PROFILE: {value}")
    return cast(RuntimeProfile, value)


def validate_runtime_backend(backend: str) -> RuntimeProfile:
    """Fail closed when a named runtime profile selects the wrong backend."""

    profile = runtime_profile()
    if profile == "demo" and backend != "fixture":
        raise RuntimeError("ORBIT_RUNTIME_PROFILE=demo requires ORBIT_AGENT_BACKEND=fixture.")
    if profile == "production" and backend == "fixture":
        raise RuntimeError(
            "ORBIT_RUNTIME_PROFILE=production cannot use ORBIT_AGENT_BACKEND=fixture."
        )
    return profile


def is_demo_fixture_runtime() -> bool:
    return (
        runtime_profile() == "demo"
        and os.getenv("ORBIT_AGENT_BACKEND", "fixture") == "fixture"
        and os.getenv("ORBIT_SCOMBZ_STUDENT_READ", "off") == "fixture"
        and os.getenv("ORBIT_OBSERVABILITY", "off") == "off"
    )
