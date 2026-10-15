# Migrations

This project has no migration library installed (and none should be added
just to manage this directory). Schema changes live here as plain, numbered
SQL files and are applied by hand.

## Convention

- Files are named `NNN_name.sql`, e.g. `001_idempotency_keys.sql`,
  `002_add_orders_index.sql`.
- `NNN` is a zero-padded, monotonically increasing sequence number.
- Files are applied in ascending numeric order, once each, and are never
  edited after being applied to any shared environment — add a new file for
  further changes instead.
- Statements should be written to be safely re-runnable where practical
  (e.g. `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`).

## Applying a migration

```bash
psql "$DATABASE_URL" -f migrations/001_idempotency_keys.sql
```

or, using the `DB_*` variables from `.env`:

```bash
PGHOST="$DB_HOST" PGUSER="$DB_USER" PGPASSWORD="$DB_PASSWORD" PGDATABASE="$DB_NAME" \
  psql -f migrations/001_idempotency_keys.sql
```
