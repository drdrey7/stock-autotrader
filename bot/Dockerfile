FROM python:3.11-slim

WORKDIR /app

# Runtime code (bot) + publisher client (apps/publisher, PR #3).
COPY bot/pyproject.toml /app/bot/pyproject.toml
COPY bot/requirements-lock.txt /app/bot/requirements-lock.txt
COPY bot/bot /app/bot/bot
COPY apps/publisher /app/apps/publisher

# apps/publisher is a plain python package on PYTHONPATH (no install step).
ENV PYTHONPATH=/app/apps/publisher:/app
ENV DATA_DIR=/app/bot/data
# Pin dependencies to requirements-lock.txt (see its header to regenerate),
# then install bot itself with --no-deps so it can't silently drift from
# those pins on a rebuild.
RUN pip install --no-cache-dir -r /app/bot/requirements-lock.txt \
 && pip install --no-cache-dir --no-deps /app/bot

# Runtime state (SQLite) lives on a volume; config comes from env / mounted .env.
VOLUME /app/bot/data
WORKDIR /app/bot

CMD ["python", "-m", "bot", "run"]
