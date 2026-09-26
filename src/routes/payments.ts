import { Router, Response } from "express";
import { query, sql, withTransaction } from "../db";
import { config } from "../config";
import { AuthedRequest } from "../middleware/authenticate";
import { chargeIdempotencyKey, newId } from "../utils/tokens";
import { Order, OrderStatus } from "../types";
import {
  chargeProcessor,
  refundProcessor,
  ProcessorError,
} from "../processor";

export const payments = Router();

// Raised inside the refund transaction when the ledger, re-read under the
// order row lock, shows the requested amount exceeds what remains refundable.
class RefundExceedsRemainingError extends Error {}

// Normalise a `COALESCE(SUM(amount), 0) AS refunded` result to integer cents.
// pg returns SUM over integer columns as a string (bigint/numeric).
function refundedCents(rows: { refunded: string | number | null }[]): number {
  const value = rows[0]?.refunded;
  return value == null ? 0 : Number(value);
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

  // Scope the lookup to the caller: another customer's reference is
  // indistinguishable from a nonexistent one (404, not 403).
  const rows = await query<Order>(
    sql`SELECT id, total, status FROM orders WHERE reference = ${reference} AND customer_id = ${req.userId}`
  );
  const order = rows[0];
  if (!order) {
    return res.status(404).json({ error: "order not found" });
  }
  if (order.status === "cancelled" || order.status === "pending") {
    return res.status(409).json({ error: "order is not refundable" });
  }

  const amountCents = Math.round(amountDollars * 100);

  // Fast path: reject against the refunds already recorded for this order so
  // a request that obviously over-refunds never reaches the transaction. The
  // authoritative check is repeated under a row lock below.
  const priorRows = await query<{ refunded: string | number | null }>(
    sql`SELECT COALESCE(SUM(amount), 0) AS refunded FROM refunds WHERE order_id = ${order.id}`
  );
  if (amountCents > order.total - refundedCents(priorRows)) {
    return res.status(422).json({ error: "refund exceeds remaining refundable amount" });
  }

  const refundId = newId();
  try {
    await withTransaction(async (client) => {
      // Serialise refunds per order: lock the order row, then re-read the
      // refund ledger so two concurrent partial refunds cannot both pass the
      // check against the same prior total.
      await client.query(sql`SELECT id FROM orders WHERE id = ${order.id} FOR UPDATE`);
      const lockedRows = await client.query<{ refunded: string | number | null }>(
        sql`SELECT COALESCE(SUM(amount), 0) AS refunded FROM refunds WHERE order_id = ${order.id}`
      );
      const alreadyRefunded = refundedCents(lockedRows);
      if (amountCents > order.total - alreadyRefunded) {
        throw new RefundExceedsRemainingError();
      }

      await refundProcessor({
        orderId: order.id,
        amount: amountCents, // cents, like every other processor call
        apiKey: config.paymentApiKey,
      });
      await client.query(
        sql`INSERT INTO refunds (id, order_id, amount) VALUES (${refundId}, ${order.id}, ${amountCents})`
      );
      const nextStatus: OrderStatus =
        alreadyRefunded + amountCents >= order.total ? "refunded" : "partially_refunded";
      await client.query(
        sql`UPDATE orders SET status = ${nextStatus} WHERE id = ${order.id}`
      );
    });
  } catch (e) {
    if (e instanceof RefundExceedsRemainingError) {
      return res.status(422).json({ error: "refund exceeds remaining refundable amount" });
    }
    throw e;
  }

  res.json({ refunded: true, refundId, amount: amountCents });
});

// Capture payment for several orders in one request (used by the back-office
// "settle outstanding" batch action).
//
// Response shape:
//   400 { error: string } when `orderIds` is missing or an empty array.
//   200 {
//     ok: boolean,                                  // true only if `failed` is empty
//     captured: string[],                           // order ids charged and marked paid, in request order
//     failed: { orderId: string; error: string }[], // "order not found" | "payment declined" | "capture failed"
//     skipped: { orderId: string; status: OrderStatus }[], // found but not pending; never charged
//   }
// Duplicate ids in the request are processed once. A 200 is returned even when
// some or all captures fail; callers must inspect `ok` / `failed`.
payments.post("/payments/capture-batch", async (req: AuthedRequest, res: Response) => {
  const { orderIds } = req.body as { orderIds: string[] };
  if (!Array.isArray(orderIds) || orderIds.length === 0) {
    return res.status(400).json({ error: "orderIds must be a non-empty array" });
  }

  const rows = await query<Order>(
    sql`SELECT id, total, status FROM orders WHERE id = ANY(${orderIds}) AND customer_id = ${req.userId}`
  );

  const byId = new Map(rows.map((order) => [order.id, order]));
  const captured: string[] = [];
  const failed: { orderId: string; error: string }[] = [];
  const skipped: { orderId: string; status: OrderStatus }[] = [];

  // Capture sequentially, in request order: one processor call in flight at a
  // time, and each order's outcome is recorded independently so one failure
  // neither aborts nor hides the rest of the batch.
  for (const orderId of new Set(orderIds)) {
    const order = byId.get(orderId);
    if (!order) {
      failed.push({ orderId, error: "order not found" });
      continue;
    }
    // Only orders still awaiting payment are charged; anything already paid,
    // refunded or cancelled must never reach the processor again.
    if (order.status !== "pending") {
      skipped.push({ orderId, status: order.status });
      continue;
    }

    try {
      await chargeProcessor({
        amount: order.total, // cents
        apiKey: config.paymentApiKey,
        idempotencyKey: chargeIdempotencyKey(order.id),
      });
      await query(sql`UPDATE orders SET status = 'paid' WHERE id = ${order.id}`);
      captured.push(order.id);
    } catch (e) {
      failed.push({
        orderId: order.id,
        error: e instanceof ProcessorError ? "payment declined" : "capture failed",
      });
    }
  }

  res.json({ ok: failed.length === 0, captured, failed, skipped });
});
