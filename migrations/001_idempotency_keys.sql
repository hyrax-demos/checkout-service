-- 001_idempotency_keys.sql
--
-- Persistence for request idempotency records. Each row tracks a
-- client-supplied idempotency key against the fingerprint of the request
-- that first used it, the processing status, and (once completed) the
-- response that should be replayed for subsequent retries of the same key.
--
-- This repo has no migration library installed (and none should be added).
-- Migrations under this directory are plain, ordered SQL files applied by
-- hand. See migrations/README.md for the naming/ordering convention.
--
-- Apply with:
--   psql "$DATABASE_URL" -f migrations/001_idempotency_keys.sql
-- or, using the DB_* env vars from .env:
--   PGHOST="$DB_HOST" PGUSER="$DB_USER" PGPASSWORD="$DB_PASSWORD" PGDATABASE="$DB_NAME" \
--     psql -f migrations/001_idempotency_keys.sql

CREATE TABLE IF NOT EXISTS idempotency_keys (
    key                  TEXT PRIMARY KEY,
    request_fingerprint  TEXT NOT NULL,
    status               TEXT NOT NULL CHECK (status IN ('in_progress', 'completed')),
    response_status      INT NULL,
    response_body        JSONB NULL,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at         TIMESTAMPTZ NULL
);

-- Supports future pruning of stale/expired keys (e.g. DELETE ... WHERE
-- created_at < now() - interval '...').
CREATE INDEX IF NOT EXISTS idempotency_keys_created_at_idx
    ON idempotency_keys (created_at);
