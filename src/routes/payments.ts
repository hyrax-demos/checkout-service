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

// Sum of every refund already recorded against an order, in integer cents.
// An order with no refunds yet has a prior total of 0.
async function priorRefundedCents(
  run: (q: SqlQuery) => Promise<{ refunded: string | number | null }[]>,
  orderId: string
): Promise<number> {
  const rows = await run(
    sql`SELECT COALESCE(SUM(amount), 0) AS refunded FROM refunds WHERE order_id = ${orderId}`
  );
  // Postgres returns SUM over integers as a bigint, which `pg` hands back as
  // a string; normalise to a number of cents.
  return Number(rows[0]?.refunded ?? 0);
}

// All three arguments are integer cents.
function exceedsOrderTotal(orderTotal: number, priorCents: number, amountCents: number): boolean {
  return priorCents + amountCents > orderTotal;
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

  // A refund may not push the order's cumulative refunded total (all prior
  // refunds plus this one) past its captured total. This early check against
  // a plain read avoids opening a transaction for an obviously-invalid
  // request; the authoritative check is repeated under a row lock below.
  if (exceedsOrderTotal(order.total, await priorRefundedCents(query, order.id), amountCents)) {
    return res.status(422).json({ error: "refund exceeds order total" });
  }

  const refundId = newId();
  const outcome = await withTransaction(async (client) => {
    // Lock the order row so concurrent refunds for the same order serialize
    // here: each one sees the refunds committed by the others before it
    // re-sums, which prevents two in-flight refunds from jointly
    // over-refunding the order.
    await client.query(sql`SELECT id FROM orders WHERE id = ${order.id} FOR UPDATE`);
    const prior = await priorRefundedCents((q) => client.query(q), order.id);
    if (exceedsOrderTotal(order.total, prior, amountCents)) {
      return { ok: false as const };
    }

    await refundProcessor({
      orderId: order.id,
      amount: amountCents, // cents
      apiKey: config.paymentApiKey,
    });
    await client.query(
      sql`INSERT INTO refunds (id, order_id, amount) VALUES (${refundId}, ${order.id}, ${amountCents})`
    );
    await client.query(
      sql`UPDATE orders SET status = 'refunded' WHERE id = ${order.id}`
    );
    return { ok: true as const };
  });

  if (!outcome.ok) {
    return res.status(422).json({ error: "refund exceeds order total" });
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
