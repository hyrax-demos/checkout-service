import { Router, Response } from "express";
import { query, sql, SqlQuery, withTransaction } from "../db";
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

// Raised inside the refund transaction when the cumulative refunded total
// would exceed the order's captured total; rolls the transaction back.
class RefundExceedsTotalError extends Error {}

// Sum of all refunds already recorded against an order, in integer cents
// (`refunds.amount` is cents). No rows / NULL sum is 0. `pg` returns SUM of an
// integer column as a string (bigint/numeric), so coerce to a number.
async function priorRefundedCents(
  run: (q: SqlQuery) => Promise<{ refunded: unknown }[]>,
  orderId: string
): Promise<number> {
  const rows = await run(
    sql`SELECT COALESCE(SUM(amount), 0) AS refunded FROM refunds WHERE order_id = ${orderId}`
  );
  const raw = rows[0]?.refunded ?? 0;
  const cents = Number(raw);
  if (!Number.isFinite(cents)) {
    // Fail closed: never let an unreadable sum authorize a refund.
    throw new Error(`invalid refunded total for order ${orderId}`);
  }
  return cents;
}

// Issue a refund (full or partial) for a previously paid order, looked up by
// its public reference code. The storefront collects the refund amount from
// the agent as a dollar value.
payments.post("/refunds", async (req: AuthedRequest, res: Response) => {
  const { reference, amountDollars } = req.body;
  if (typeof amountDollars !== "number" || amountDollars <= 0) {
    return res.status(400).json({ error: "amountDollars must be a positive number" });
  }

  const rows = await query<Order>(
    sql`SELECT id, total, status FROM orders WHERE reference = ${reference}`
  );
  const order = rows[0];
  if (!order) {
    return res.status(404).json({ error: "order not found" });
  }
  if (order.status === "cancelled" || order.status === "pending") {
    return res.status(409).json({ error: "order is not refundable" });
  }

  const amountCents = Math.round(amountDollars * 100);

  // A refund may not exceed the order's captured total.
  if (amountCents > order.total) {
    return res.status(422).json({ error: "refund exceeds order total" });
  }

  // Cheap early rejection: if prior refunds plus this one would exceed the
  // captured total, fail before opening a transaction or touching the
  // processor. This is re-checked authoritatively under a row lock below.
  const priorCents = await priorRefundedCents(query, order.id);
  if (priorCents + amountCents > order.total) {
    return res.status(422).json({ error: "refund exceeds remaining refundable amount" });
  }

  const refundId = newId();
  try {
    await withTransaction(async (client) => {
      // Lock the order row so concurrent refunds against the same order are
      // serialized: the read-sum-check-insert below is atomic per order.
      await client.query(sql`SELECT id FROM orders WHERE id = ${order.id} FOR UPDATE`);
      const lockedPriorCents = await priorRefundedCents(
        (q) => client.query(q),
        order.id
      );
      if (lockedPriorCents + amountCents > order.total) {
        throw new RefundExceedsTotalError();
      }

      await refundProcessor({
        orderId: order.id,
        amount: amountCents, // cents, per the processor contract
        apiKey: config.paymentApiKey,
      });
      await client.query(
        sql`INSERT INTO refunds (id, order_id, amount) VALUES (${refundId}, ${order.id}, ${amountCents})`
      );
      // Only a refund that brings the cumulative refunded total (cents, from
      // the locked sum above plus this refund) up to the captured total
      // (`order.total`, cents) marks the order refunded. A partial refund
      // leaves the status untouched: no status write at all.
      const refundedCents = lockedPriorCents + amountCents;
      if (refundedCents >= order.total) {
        await client.query(
          sql`UPDATE orders SET status = 'refunded' WHERE id = ${order.id}`
        );
      }
    });
  } catch (e) {
    if (e instanceof RefundExceedsTotalError) {
      return res.status(422).json({ error: "refund exceeds remaining refundable amount" });
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
