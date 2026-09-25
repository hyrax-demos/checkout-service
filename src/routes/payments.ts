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

  // `order.total` is integer cents (see `Order` in ../types), as is every
  // `refunds.amount`, so all comparisons below are cents-to-cents. The
  // cumulative check subsumes the single-request one (prior = 0).
  const exceedsTotal = (priorRefundedCents: number) =>
    priorRefundedCents + amountCents > order.total;

  // Cheap early reject outside the transaction; re-checked under lock below.
  if (exceedsTotal(await priorRefundedCents(query, order.id))) {
    return res.status(422).json({ error: "refund exceeds order total" });
  }

  const refundId = newId();
  const outcome = await withTransaction(async (client) => {
    // Lock the order row so concurrent refunds for the same order serialize
    // here, then re-sum: another refund may have committed since the check
    // above.
    await client.query(sql`SELECT id FROM orders WHERE id = ${order.id} FOR UPDATE`);
    const priorCents = await priorRefundedCents((q) => client.query(q), order.id);
    if (exceedsTotal(priorCents)) {
      return "exceeds_total" as const;
    }

    await refundProcessor({
      orderId: order.id,
      amount: amountCents, // cents, per RefundArgs contract
      apiKey: config.paymentApiKey,
    });
    await client.query(
      sql`INSERT INTO refunds (id, order_id, amount) VALUES (${refundId}, ${order.id}, ${amountCents})`
    );
    // Only a refund that brings the cumulative total (cents, including this
    // one) up to the captured total marks the order refunded; a partial
    // refund leaves the order's status as it was.
    const cumulativeCents = priorCents + amountCents;
    if (cumulativeCents >= order.total) {
      await client.query(
        sql`UPDATE orders SET status = 'refunded' WHERE id = ${order.id}`
      );
    }
    return "refunded" as const;
  });

  if (outcome === "exceeds_total") {
    return res.status(422).json({ error: "refund exceeds order total" });
  }

  res.json({ refunded: true, refundId, amount: amountCents });
});

// Sum (in cents) of every refund already recorded against an order; 0 when
// there are none. `SUM` over a bigint-ish column comes back from pg as a
// string, hence the `Number`.
async function priorRefundedCents(
  run: (q: SqlQuery) => Promise<{ refunded: string | number }[]>,
  orderId: string
): Promise<number> {
  const rows = await run(
    sql`SELECT COALESCE(SUM(amount), 0) AS refunded FROM refunds WHERE order_id = ${orderId}`
  );
  return Number(rows[0]?.refunded ?? 0);
}

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
