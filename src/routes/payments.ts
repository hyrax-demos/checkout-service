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

// Issue a refund (full or partial) for a previously paid order, looked up by
// its public reference code. The storefront collects the refund amount from
// the agent as a dollar value; everything past input parsing is in cents.
//
// The flow is split into three phases so that money never moves without a
// durable record of it:
//   1. reserve  — in a short transaction, lock the order, check the amount
//                 against what is still refundable (counting pending refunds
//                 so concurrent requests cannot over-refund), and insert the
//                 refund row as 'pending'.
//   2. execute  — call the processor, outside any DB transaction.
//   3. settle   — mark the row 'succeeded' (and roll the order status forward)
//                 or 'failed' on a processor decline. Any other error leaves
//                 the row 'pending' for reconciliation.
payments.post("/refunds", async (req: AuthedRequest, res: Response) => {
  const { reference, amountDollars } = req.body;
  if (typeof amountDollars !== "number" || amountDollars <= 0) {
    return res.status(400).json({ error: "amountDollars must be a positive number" });
  }

  const rows = await query<Order>(
    sql`SELECT id, total, status FROM orders WHERE reference = ${reference} AND customer_id = ${req.userId}`
  );
  const order = rows[0];
  if (!order) {
    return res.status(404).json({ error: "order not found" });
  }
  if (order.status !== "paid" && order.status !== "partially_refunded") {
    return res.status(409).json({ error: "order is not refundable" });
  }

  const amountCents = Math.round(amountDollars * 100);
  const refundId = newId();

  // Phase 1: reserve.
  const reserved = await withTransaction(async (client) => {
    // Serialise concurrent refunds of the same order.
    await client.query(sql`SELECT id FROM orders WHERE id = ${order.id} FOR UPDATE`);
    const sums = await client.query<{ refunded: string | number | null }>(
      sql`SELECT COALESCE(SUM(amount), 0) AS refunded FROM refunds WHERE order_id = ${order.id} AND status <> 'failed'`
    );
    const alreadyRefunded = Number(sums[0]?.refunded ?? 0);
    if (alreadyRefunded + amountCents > order.total) {
      return { ok: false as const, remaining: Math.max(order.total - alreadyRefunded, 0) };
    }
    await client.query(
      sql`INSERT INTO refunds (id, order_id, amount, status) VALUES (${refundId}, ${order.id}, ${amountCents}, 'pending')`
    );
    return { ok: true as const };
  });
  if (!reserved.ok) {
    return res.status(422).json({
      error: "refund exceeds remaining refundable amount",
      remaining: reserved.remaining,
    });
  }

  // Phase 2: execute.
  try {
    await refundProcessor({
      orderId: order.id,
      amount: amountCents, // cents
      apiKey: config.paymentApiKey,
    });
  } catch (e) {
    if (e instanceof ProcessorError) {
      await query(sql`UPDATE refunds SET status = 'failed' WHERE id = ${refundId}`);
      return res.status(402).json({ error: "refund declined", refundId });
    }
    // Outcome unknown: leave the row 'pending' so it can be reconciled.
    throw e;
  }

  // Phase 3: settle.
  await query(sql`UPDATE refunds SET status = 'succeeded' WHERE id = ${refundId}`);
  await query(
    sql`UPDATE orders SET status = CASE WHEN (SELECT COALESCE(SUM(amount), 0) FROM refunds WHERE order_id = ${order.id} AND status = 'succeeded') >= total THEN 'refunded' ELSE 'partially_refunded' END WHERE id = ${order.id}`
  );

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
