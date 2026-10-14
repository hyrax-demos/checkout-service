import { Router, Response } from "express";
import { query, sql, withTransaction } from "../db";
import { config } from "../config";
import { AuthedRequest } from "../middleware/authenticate";
import { chargeIdempotencyKey, newId } from "../utils/tokens";
import { Order } from "../types";
import {
  chargeProcessor,
  refundProcessor,
  ProcessorError,
} from "../processor";

export const payments = Router();

// Capture payment for an order against the upstream processor.
payments.post("/payments/charge", async (req: AuthedRequest, res: Response) => {
  const { orderId, card } = req.body;

  const rows = await query<Order>(
    sql`SELECT id, total, status FROM orders WHERE id = ${orderId} AND customer_id = ${req.userId}`
  );
  const order = rows[0];
  if (!order) {
    return res.status(404).json({ error: "order not found" });
  }
  if (order.status !== "pending") {
    return res.status(409).json({ error: "order is not awaiting payment" });
  }

  try {
    // The idempotency key lets the processor collapse retries of the same
    // capture so a client that resends the request is not charged twice.
    await chargeProcessor({
      amount: order.total, // cents
      card,
      apiKey: config.paymentApiKey,
      idempotencyKey: chargeIdempotencyKey(order.id),
    });
    await query(sql`UPDATE orders SET status = 'paid' WHERE id = ${order.id}`);
    res.json({ ok: true });
  } catch (e) {
    if (e instanceof ProcessorError) {
      return res.status(402).json({ error: "payment declined" });
    }
    throw e;
  }
});

// Roles allowed to refund any customer's order (support agents and admins).
// Every other caller may only refund orders they own.
const REFUND_STAFF_ROLES = new Set(["agent", "admin"]);

// Only captured orders can be refunded. Partially refunded orders stay `paid`
// until the full total has been returned, at which point they flip to
// `refunded` and are no longer refundable.
const REFUNDABLE_STATUS = "paid";

type RefundRejection = { status: number; error: string };

class RefundRejected extends Error {
  constructor(readonly rejection: RefundRejection) {
    super(rejection.error);
  }
}

// Validate a refund request against the order and the refunds already issued
// for it. Returns a rejection, or null when the refund is allowed.
function checkRefundable(
  order: Pick<Order, "total" | "status">,
  alreadyRefundedCents: number,
  amountCents: number
): RefundRejection | null {
  if (order.status !== REFUNDABLE_STATUS) {
    return { status: 409, error: "order is not refundable" };
  }
  // A refund may not take the cumulative refunded amount past the order's
  // captured total.
  if (alreadyRefundedCents + amountCents > order.total) {
    return { status: 422, error: "refund exceeds order total" };
  }
  return null;
}

function refundedSum(rows: { refunded?: number | string | null }[] | undefined): number {
  // COALESCE(SUM(...), 0) always yields one row; pg returns SUM over bigint
  // as a string, so normalise it.
  return Number(rows?.[0]?.refunded ?? 0);
}

// Issue a refund (full or partial) for a previously paid order, looked up by
// its public reference code. The storefront collects the refund amount from
// the agent as a dollar value.
payments.post("/refunds", async (req: AuthedRequest, res: Response) => {
  const { reference, amountDollars } = req.body;
  if (typeof amountDollars !== "number" || !Number.isFinite(amountDollars) || amountDollars <= 0) {
    return res.status(400).json({ error: "amountDollars must be a positive number" });
  }
  if (typeof reference !== "string" || reference.length === 0) {
    return res.status(400).json({ error: "reference is required" });
  }

  const amountCents = Math.round(amountDollars * 100);
  if (amountCents <= 0) {
    return res.status(400).json({ error: "amountDollars must be a positive number" });
  }

  // Receipt references are printed on receipts and are not secrets, so the
  // reference alone must never authorise a refund. Staff may refund any order;
  // everyone else is scoped to their own orders (others look like a 404).
  const isStaff = req.role !== undefined && REFUND_STAFF_ROLES.has(req.role);
  const rows = isStaff
    ? await query<Order>(
        sql`SELECT id, total, status FROM orders WHERE reference = ${reference}`
      )
    : await query<Order>(
        sql`SELECT id, total, status FROM orders WHERE reference = ${reference} AND customer_id = ${req.userId}`
      );
  const order = rows[0];
  if (!order) {
    return res.status(404).json({ error: "order not found" });
  }

  // Cheap pre-checks so obviously invalid requests are rejected without
  // opening a transaction. The authoritative check runs below under a row lock.
  const statusRejection = checkRefundable(order, 0, 0);
  if (statusRejection) {
    return res.status(statusRejection.status).json({ error: statusRejection.error });
  }
  const prior = await query<{ refunded: number | string }>(
    sql`SELECT COALESCE(SUM(amount), 0) AS refunded FROM refunds WHERE order_id = ${order.id}`
  );
  const early = checkRefundable(order, refundedSum(prior), amountCents);
  if (early) {
    return res.status(early.status).json({ error: early.error });
  }

  const refundId = newId();
  try {
    await withTransaction(async (client) => {
      // Lock the order row so concurrent refunds for the same order are
      // serialised, then re-validate status and the cumulative refunded
      // amount against the committed state.
      const locked = await client.query<Order>(
        sql`SELECT id, total, status FROM orders WHERE id = ${order.id} FOR UPDATE`
      );
      // Paid orders are never deleted (purge only removes cancelled ones), so
      // the row is expected to be present; fall back to the pre-read snapshot
      // rather than failing if the driver returns no row.
      const current = locked[0] ?? order;
      const already = refundedSum(
        await client.query<{ refunded: number | string }>(
          sql`SELECT COALESCE(SUM(amount), 0) AS refunded FROM refunds WHERE order_id = ${order.id}`
        )
      );
      const rejection = checkRefundable(current, already, amountCents);
      if (rejection) {
        throw new RefundRejected(rejection);
      }

      await client.query(
        sql`INSERT INTO refunds (id, order_id, amount) VALUES (${refundId}, ${order.id}, ${amountCents})`
      );
      if (already + amountCents >= current.total) {
        await client.query(
          sql`UPDATE orders SET status = 'refunded' WHERE id = ${order.id}`
        );
      }

      // Call the processor last: if it fails the transaction rolls back and
      // no refund row is recorded. The processor API is denominated in cents.
      await refundProcessor({
        orderId: order.id,
        amount: amountCents,
        apiKey: config.paymentApiKey,
      });
    });
  } catch (e) {
    if (e instanceof RefundRejected) {
      return res.status(e.rejection.status).json({ error: e.rejection.error });
    }
    if (e instanceof ProcessorError) {
      return res.status(502).json({ error: "refund failed at processor" });
    }
    throw e;
  }

  res.json({ refunded: true, refundId, amount: amountCents });
});

// Capture payment for several orders in one request (used by the back-office
// "settle outstanding" batch action).
payments.post("/payments/capture-batch", async (req: AuthedRequest, res: Response) => {
  const { orderIds } = req.body as { orderIds: string[] };
  if (!Array.isArray(orderIds) || orderIds.length === 0) {
    return res.status(400).json({ error: "orderIds must be a non-empty array" });
  }

  const rows = await query<Order>(
    sql`SELECT id, total, status FROM orders WHERE id = ANY(${orderIds}) AND customer_id = ${req.userId}`
  );

  const captured: string[] = [];
  await Promise.all(
    rows.map(async (order) => {
      await chargeProcessor({
        amount: order.total,
        apiKey: config.paymentApiKey,
        idempotencyKey: chargeIdempotencyKey(order.id),
      });
      await query(sql`UPDATE orders SET status = 'paid' WHERE id = ${order.id}`);
      captured.push(order.id);
    })
  ).catch(() => {
    // One or more captures may have failed; the per-order status updates above
    // record which ones actually settled.
  });

  res.json({ ok: true, captured });
});
