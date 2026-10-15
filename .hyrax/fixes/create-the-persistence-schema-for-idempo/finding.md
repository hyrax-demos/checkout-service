# Create the persistence schema for idempotency records as a raw SQL script (no m…

**Tool:** `task`
**Severity:** unspecified

## What's wrong

Create the persistence schema for idempotency records as a raw SQL script (no migration library — none is installed and none may be added).

Work:
1. Create `migrations/001_idempotency_keys.sql` containing a `CREATE TABLE IF NOT EXISTS idempotency_keys (...)` statement matching the DESIGN CONTRACT exactly: `key TEXT PRIMARY KEY`, `request_fingerprint TEXT NOT NULL`, `status TEXT NOT NULL`, `response_status INT NULL`, `response_body JSONB NULL`, `created_at TIMESTAMPTZ NOT NULL DEFAULT now()`, `completed_at TIMESTAMPTZ NULL`.
2. Add a `CHECK (status IN ('in_progress','completed'))` constraint and an index on `created_at` (for future pruning of stale keys).
3. Add a short header comment in the .sql file explaining what the table is for and that it is applied manually (`psql "$DATABASE_URL" -f migrations/001_idempotency_keys.sql` or via the DB_* env vars) because the repo has no migration tool.
4. Create `migrations/README.md` (a few lines) stating the ordering convention (`NNN_name.sql`, applied in ascending order) and the apply command.

Do not touch `src/index.ts` in this step. Do not touch `package.json` dependencies.
