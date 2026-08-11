FROM python:3.11-slim

WORKDIR /app

# Runtime code (bot) + publisher client (apps/publisher, PR #3).
COPY bot/pyproject.toml /app/bot/pyproject.toml
COPY bot/bot /app/bot/bot
COPY apps/publisher /app/apps/publisher

# apps/publisher is a plain python package on PYTHONPATH (no install step).
ENV PYTHONPATH=/app/apps/publisher:/app
ENV DATA_DIR=/app/bot/data
RUN pip install --no-cache-dir /app/bot

# Runtime state (SQLite) lives on a volume; config comes from env / mounted .env.
VOLUME /app/bot/data
WORKDIR /app/bot

CMD ["python", "-m", "bot", "run"]
