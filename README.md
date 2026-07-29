# SIT ORBIT

> Two Campuses. Four Years. One Orbit.

SIT ORBIT is a Personal Campus Agent for Shibaura Institute of Technology.
It turns campus events into a concrete next action, records the result, and
connects daily learning to long-term evidence.

This repository is an early foundation for the AI Innovators Cup 2026 demo.
It contains:

- a FastAPI agent API,
- a Next.js web application,
- an Expo mobile application,
- deterministic fixtures that do not call an external model,
- optional OpenAI and W&B Weave adapters for synthetic demo data.

## Requirements

- Python 3.13
- uv
- Node.js 24 LTS
- pnpm 11.9.0

## Setup

```bash
uv sync
pnpm install
pnpm generate:api
```

Copy `.env.example` to `.env` only when you need the API demo or W&B traces.
The default configuration uses the deterministic fixture backend.

## Run

```bash
uv run uvicorn orbit_api.main:app --app-dir services/api --reload
pnpm --filter @sit-orbit/web dev
pnpm --filter @sit-orbit/mobile start
```

## Verify

```bash
uv run ruff check .
uv run pyright
uv run pytest
PYTHONPATH=services/api uv run python -m evals.run_eval
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

## Data policy

W&B Weave and OpenAI are disabled by default.
Only public or synthetic demonstration data may be sent to either service.
Do not add student records, grades, private course materials, unpublished
research, API keys, or OAuth tokens to this repository.

See `docs/data-policy.md` for the full MVP policy.
Personal Campus Agent for Shibaura Institute of Technology
