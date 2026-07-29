# SIT ORBIT Agent Contract

## Mission

SIT ORBIT is a Personal Campus Agent for Shibaura Institute of Technology.
The current MVP converts one campus event into an evidence-backed action,
records explicit user approval, and converts completion into a new event.

## Current scope

- FastAPI agent API in `services/api`.
- Next.js web UI in `apps/web`.
- Expo mobile UI in `apps/mobile`.
- OpenAPI-generated TypeScript types in `packages/api-client`.
- B1 Omiya is the release fixture.
- B3 Toyosu is a draft fixture and must not be presented as validated.

Do not add a graph database, message broker, multi-agent framework, policy
engine, or new service without a concrete current requirement.

## Source of truth

- Pydantic models in `services/api/orbit_api/models` define the API contract.
- `docs/product.md` defines the product intent.
- `docs/data-policy.md` defines what may leave the local environment.
- `docs/contest.md` reproduces the official judging perspectives without
  inventing weights.

## Development commands

Use Python only through `uv`.

```bash
uv sync
uv run ruff check .
uv run pyright
uv run pytest
PYTHONPATH=services/api uv run python -m evals.run_eval
```

Use pnpm for Node.js work.

```bash
pnpm install
pnpm generate:api
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

## Model and observability policy

- Normal development and CI use `ORBIT_AGENT_BACKEND=fixture`.
- Do not call an external model while writing or running ordinary tests.
- Never silently fall back from one model or backend to another.
- OpenAI requires both `ORBIT_AGENT_BACKEND=openai` and an API key.
- W&B requires `ORBIT_OBSERVABILITY=wandb` and explicit W&B configuration.
- Only `synthetic` or `public` data may be sent to OpenAI or W&B.
- Never send student records, grades, private course material, unpublished
  research, private Drive content, credentials, or OAuth tokens.

## Product invariants

- External writes remain proposals until the user explicitly confirms them.
- AI-derived text is not an official university record.
- Every action proposal names the evidence used to produce it.
- Do not claim ScombZ, SIT Portfolio, My Library, or campus infrastructure is
  integrated until a real authorized integration exists.
- Do not retain continuous location history.
- If a requested integration is unavailable, explain the limitation instead
  of adding a hidden fallback or simulated success.

## Git workflow

- Work on a `codex/` branch.
- Do not push directly to `main`.
- Preserve unrelated user changes.
- Use prefixed commit subjects such as `chore:`, `feat:`, `docs:`, or `ci:`.
- Confirm before destructive operations, force pushes, mass deletion, or
  overwriting checkpoints.

## Verification

Run the smallest relevant checks after each change.
Before a pull request, run the full Python and pnpm command sets above.
API contract changes require `pnpm generate:api` and generated-type review.
Long-running work must use a named tmux session and an explicit log path.

## Stop conditions

Stop and report the reason when implementation would require unauthorized
university access, real student data, unknown external write permissions, or a
material expansion beyond the current MVP.
