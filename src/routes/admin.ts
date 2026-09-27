import { Router, Request, Response } from "express";
import { query, sql } from "../db";
import { webhookEventLog } from "../webhookEventLog";

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

const DEFAULT_WEBHOOK_EVENTS_LIMIT = 50;
const MAX_WEBHOOK_EVENTS_LIMIT = 200;

// Parse an optional non-negative integer query parameter. Returns undefined
// when absent and null when present but invalid.
function intParam(value: unknown): number | undefined | null {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : null;
}

// List recorded processor webhook deliveries, newest first, including
// duplicates and rejected attempts. Paginated with `limit` (1-200, default 50)
// and `offset` (default 0).
admin.get("/admin/webhook-events", async (req: Request, res: Response) => {
  const limit = intParam(req.query.limit);
  const offset = intParam(req.query.offset);
  if (
    limit === null ||
    offset === null ||
    (limit !== undefined && (limit < 1 || limit > MAX_WEBHOOK_EVENTS_LIMIT))
  ) {
    return res.status(400).json({
      error: `limit must be an integer between 1 and ${MAX_WEBHOOK_EVENTS_LIMIT} and offset a non-negative integer`,
    });
  }
  const page = { limit: limit ?? DEFAULT_WEBHOOK_EVENTS_LIMIT, offset: offset ?? 0 };
  const { events, total } = await webhookEventLog.list(page);
  res.json({ events, total, ...page });
});
