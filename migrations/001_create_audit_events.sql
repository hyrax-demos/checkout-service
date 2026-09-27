-- Append-only audit trail for money-moving actions (charges, refunds and
-- capture-batch captures). Each row is written in the same statement or
-- transaction as the change it records, so an order's status never commits
-- without its audit row, and vice versa.
--
-- order_id and customer_id have no foreign keys on purpose. The audit trail
-- has to outlive the rows it describes (for example, /admin/orders/purge
-- deletes cancelled orders).
CREATE TABLE IF NOT EXISTS audit_events (
  id           UUID        PRIMARY KEY,
  customer_id  TEXT        NOT NULL,
  action       TEXT        NOT NULL,
  order_id     TEXT        NOT NULL,
  amount_cents BIGINT      NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Supports GET /admin/audit, which lists events newest first.
CREATE INDEX IF NOT EXISTS audit_events_created_at_idx
  ON audit_events (created_at DESC, id DESC);
