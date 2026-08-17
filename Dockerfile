FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH=/app/services/api

WORKDIR /app

RUN pip install --no-cache-dir uv==0.10.12

COPY pyproject.toml uv.lock README.md ./
COPY services/api ./services/api

RUN uv sync --frozen --no-dev

EXPOSE 8080

CMD ["uv", "run", "--no-dev", "uvicorn", "orbit_api.main:app", "--host", "0.0.0.0", "--port", "8080"]
