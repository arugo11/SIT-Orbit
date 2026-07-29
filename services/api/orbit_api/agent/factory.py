import os

from .base import AgentBackend
from .fixture import FixtureAgent
from .openai_backend import build_openai_agent


def get_agent_backend() -> AgentBackend:
    backend = os.getenv("ORBIT_AGENT_BACKEND", "fixture")
    if backend == "fixture":
        return FixtureAgent()
    if backend == "openai":
        return build_openai_agent()
    raise RuntimeError(f"Unsupported ORBIT_AGENT_BACKEND: {backend}")
