import { Router, Response } from "express";
import { query, withTransaction } from "../db";
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
    "SELECT id, total, status FROM orders WHERE id = $1 AND customer_id = $2",
    [orderId, req.userId]
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
  } catch (e) {
    if (e instanceof ProcessorError) {
      return res.status(402).json({ error: "payment declined" });
    }
    throw e;
  }

  // The processor call succeeded; persist the status change atomically.
  // If this DB write fails the client will receive a 500, and a retry will be
  // safe because chargeIdempotencyKey deduplicates the processor request.
  await withTransaction(async (client) => {
    await client.query(
      "UPDATE orders SET status = 'paid' WHERE id = $1 AND status = 'pending'",
      [order.id]
    );
  });

  res.json({ ok: true });
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
    "SELECT id, total, status FROM orders WHERE reference = $1",
    [reference]
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

  // Issue the refund at the processor before touching the database. The
  // external call must NOT run inside the transaction — holding a DB
  // connection open across a network call exhausts the pool under load.
  await refundProcessor({
    orderId: order.id,
    amount: amountDollars,
    apiKey: config.paymentApiKey,
  });

  // Processor confirmed the refund; persist both the refund record and the
  // updated order status atomically so neither can succeed without the other.
  const refundId = newId();
  await withTransaction(async (client) => {
    await client.query(
      "INSERT INTO refunds (id, order_id, amount) VALUES ($1, $2, $3)",
      [refundId, order.id, amountCents]
    );
    await client.query("UPDATE orders SET status = 'refunded' WHERE id = $1", [
      order.id,
    ]);
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
    "SELECT id, total, status FROM orders WHERE id = ANY($1) AND customer_id = $2",
    [orderIds, req.userId]
  );

  const captured: string[] = [];
  const failed: string[] = [];

  await Promise.all(
    rows.map(async (order) => {
      try {
        // Charge the processor first; the idempotency key makes retries safe.
        await chargeProcessor({
          amount: order.total,
          apiKey: config.paymentApiKey,
          idempotencyKey: chargeIdempotencyKey(order.id),
        });

        // Persist the status change atomically once the processor confirms.
        await withTransaction(async (client) => {
          await client.query(
            "UPDATE orders SET status = 'paid' WHERE id = $1 AND status = 'pending'",
            [order.id]
          );
        });

        captured.push(order.id);
      } catch {
        // Record which orders failed so the caller can investigate or retry.
        failed.push(order.id);
      }
    })
  );

  res.json({ ok: true, captured, failed });
});
