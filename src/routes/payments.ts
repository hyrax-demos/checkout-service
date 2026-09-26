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
// the agent as a dollar value.
payments.post("/refunds", async (req: AuthedRequest, res: Response) => {
  const { reference, amountDollars } = req.body;
  if (
    typeof amountDollars !== "number" ||
    !Number.isFinite(amountDollars) ||
    amountDollars <= 0
  ) {
    return res.status(400).json({ error: "amountDollars must be a positive number" });
  }

  // The processor's API (like our `Order.total`) takes integer cents, so
  // convert the storefront's dollar value to minor units. Rounding absorbs
  // floating-point artifacts (e.g. 19.99 * 100 = 1998.9999...), but a value
  // with a genuine sub-cent fraction (e.g. 1.005) is rejected rather than
  // silently rounded to a different amount than the caller asked for.
  const scaled = amountDollars * 100;
  const amountCents = Math.round(scaled);
  if (Math.abs(scaled - amountCents) > 1e-6) {
    return res
      .status(400)
      .json({ error: "amountDollars must be a whole number of cents" });
  }

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

  // A refund may not exceed the order's captured total.
  if (amountCents > order.total) {
    return res.status(422).json({ error: "refund exceeds order total" });
  }

  const refundId = newId();
  await withTransaction(async (client) => {
    await refundProcessor({
      orderId: order.id,
      amount: amountCents,
      apiKey: config.paymentApiKey,
    });
    await client.query(
      sql`INSERT INTO refunds (id, order_id, amount) VALUES (${refundId}, ${order.id}, ${amountCents})`
    );
    await client.query(
      sql`UPDATE orders SET status = 'refunded' WHERE id = ${order.id}`
    );
  });

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

interface RefundRow {
  id: string;
  amount: number | string; // cents; pg returns BIGINT/NUMERIC as a string
  created_at: Date | string;
}

// List the refunds issued against one of the authenticated customer's orders,
// newest first, along with how much of the order total is still refundable.
// Responds 404 for an order the caller does not own so it is not possible to
// probe for another customer's order ids.
payments.get("/orders/:id/refunds", async (req: AuthedRequest, res: Response) => {
  const orders = await query<Order>(
    sql`SELECT id, total, status FROM orders WHERE id = ${req.params.id} AND customer_id = ${req.userId}`
  );
  const order = orders[0];
  if (!order) {
    return res.status(404).json({ error: "order not found" });
  }

  const rows = await query<RefundRow>(
    sql`SELECT id, amount, created_at FROM refunds WHERE order_id = ${order.id} ORDER BY created_at DESC, id DESC`
  );

  // Normalise and sort again here so the response order is well-defined
  // however the rows arrive (Array.prototype.sort is stable, so equal
  // timestamps keep the database's tie-break order).
  const refunds = rows
    .map((r) => ({
      id: r.id,
      amount: Number(r.amount), // cents
      created_at: new Date(r.created_at).toISOString(),
    }))
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));

  const refunded = refunds.reduce((sum, r) => sum + r.amount, 0);
  const remaining = Number(order.total) - refunded; // cents

  res.json({ orderId: order.id, refunds, remaining });
});
