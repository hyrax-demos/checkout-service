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

// Raised inside the refund transaction to roll it back when the cumulative
// refunded total would exceed the order's captured total.
class RefundExceedsTotalError extends Error {}

// Sum of all refunds already recorded against an order, in integer cents.
// No rows -> 0. `run` is either the pool-level `query` or a transaction
// client's `query`, so the same lookup can run inside a transaction.
async function priorRefundedCents(
  run: (q: SqlQuery) => Promise<{ refunded: string | number }[]>,
  orderId: string
): Promise<number> {
  const rows = await run(
    sql`SELECT COALESCE(SUM(amount), 0) AS refunded FROM refunds WHERE order_id = ${orderId}`
  );
  // pg returns SUM() over an integer column as a string; normalise to number.
  return Number(rows[0]?.refunded ?? 0);
}

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

  // The order's cumulative refunds (this one included) may not exceed its
  // captured total. `order.total` and `refunds.amount` are both integer cents.
  // A refund that brings the cumulative total exactly to `order.total` is
  // allowed. This also covers a single refund that alone exceeds the total.
  // Fast-path check outside the transaction; re-checked under a row lock below.
  const priorRefunded = await priorRefundedCents(query, order.id);
  if (priorRefunded + amountCents > order.total) {
    return res.status(422).json({ error: "refund exceeds order total" });
  }

  const refundId = newId();
  try {
    await withTransaction(async (client) => {
      // Lock the order row so concurrent refunds against the same order
      // serialize here, then re-check against the ledger as seen under the
      // lock. Without this, two concurrent requests could both pass the check
      // above and together over-refund the order.
      await client.query(
        sql`SELECT id FROM orders WHERE id = ${order.id} FOR UPDATE`
      );
      const lockedPrior = await priorRefundedCents(
        (q) => client.query(q),
        order.id
      );
      if (lockedPrior + amountCents > order.total) {
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
      // Only mark the order refunded once the cumulative refunded total (this
      // refund included, both in cents) reaches its captured total. A partial
      // refund leaves the order row untouched, status included.
      if (lockedPrior + amountCents >= order.total) {
        await client.query(
          sql`UPDATE orders SET status = 'refunded' WHERE id = ${order.id}`
        );
      }
    });
  } catch (e) {
    if (e instanceof RefundExceedsTotalError) {
      return res.status(422).json({ error: "refund exceeds order total" });
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
