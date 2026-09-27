import { Router, Request, Response } from "express";
import { query, sql } from "../db";
import { AuditEvent } from "../types";

export const admin = Router();

// Remove all cancelled orders. Intended for periodic internal cleanup.
// The router is mounted behind `authenticate` + `requireRole("admin")`, so the
// caller's admin role has already been verified from a signed token.
admin.post("/admin/orders/purge", async (_req: Request, res: Response) => {
  const rows = await query<{ id: string }>(
    sql`DELETE FROM orders WHERE status = 'cancelled' RETURNING id`
  );
  res.json({ purged: rows.length });
});

// Issue a manual account credit to a customer. Finance-only operation.
admin.post("/admin/credits", async (req: Request, res: Response) => {
  const { customerId, amount } = req.body;
  if (typeof customerId !== "string" || typeof amount !== "number") {
    return res.status(400).json({ error: "customerId and amount are required" });
  }
  await query(
    sql`INSERT INTO account_credits (customer_id, amount) VALUES (${customerId}, ${amount})`
  );
  res.json({ credited: true });
});

const AUDIT_DEFAULT_LIMIT = 50;
const AUDIT_MAX_LIMIT = 200;

// Parse an optional non-negative integer query parameter. Returns `undefined`
// when the parameter is absent and `null` when it is present but invalid.
function parseNonNegativeInt(value: unknown): number | undefined | null {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    return null;
  }
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : null;
}

// List money-moving audit events (charges, refunds, capture-batch captures),
// newest first. Supports `limit` (1..200, default 50) and `offset` (default 0)
// pagination.
admin.get("/admin/audit", async (req: Request, res: Response) => {
  const limit = parseNonNegativeInt(req.query.limit);
  const offset = parseNonNegativeInt(req.query.offset);
  if (limit === null || limit === 0 || (limit !== undefined && limit > AUDIT_MAX_LIMIT)) {
    return res
      .status(400)
      .json({ error: `limit must be an integer between 1 and ${AUDIT_MAX_LIMIT}` });
  }
  if (offset === null) {
    return res.status(400).json({ error: "offset must be a non-negative integer" });
  }
  const effectiveLimit = limit ?? AUDIT_DEFAULT_LIMIT;
  const effectiveOffset = offset ?? 0;

  const rows = await query<AuditEvent>(
    sql`SELECT id, customer_id AS "customerId", action, order_id AS "orderId",
               amount_cents AS "amountCents", created_at AS "createdAt"
        FROM audit_events
        ORDER BY created_at DESC, id DESC
        LIMIT ${effectiveLimit} OFFSET ${effectiveOffset}`
  );
  // `pg` returns BIGINT columns as strings. Audit amounts come from order
  // totals, which are safe integers, so convert them back to numbers.
  const events = rows.map((row) => ({ ...row, amountCents: Number(row.amountCents) }));
  res.json({ events, limit: effectiveLimit, offset: effectiveOffset });
});
