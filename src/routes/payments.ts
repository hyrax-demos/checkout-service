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

  const refundId = newId();
  await withTransaction(async (client) => {
    await refundProcessor({
      orderId: order.id,
      amount: amountDollars,
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

  // Only orders still awaiting payment may be captured. Anything else that was
  // requested (already paid, cancelled, refunded, or not found for this
  // caller) is reported back as skipped rather than charged. The status read
  // above is only a pre-filter; the claim below is what actually decides.
  const candidates = rows.filter((order) => order.status === "pending");
  const candidateIds = new Set(candidates.map((order) => order.id));
  const skipped = [...new Set(orderIds)].filter((id) => !candidateIds.has(id));

  const captured: string[] = [];
  await Promise.all(
    candidates.map(async (order) => {
      // Atomically claim the order by moving it out of `pending` before any
      // money moves. If a concurrent request (another batch, a single charge,
      // or a webhook) changed the status after the lookup above, no row comes
      // back and this order is skipped instead of being charged a second time.
      const claimed = await query<{ id: string }>(
        sql`UPDATE orders SET status = 'paid'
            WHERE id = ${order.id} AND customer_id = ${req.userId} AND status = 'pending'
            RETURNING id`
      );
      if (claimed.length === 0) {
        skipped.push(order.id);
        return;
      }

      try {
        await chargeProcessor({
          amount: order.total,
          apiKey: config.paymentApiKey,
          idempotencyKey: chargeIdempotencyKey(order.id),
        });
        captured.push(order.id);
      } catch {
        // The capture did not settle: release the claim so the order can be
        // retried. The update only fires if nothing else has changed the
        // status since this request claimed it.
        await query(
          sql`UPDATE orders SET status = 'pending' WHERE id = ${order.id} AND status = 'paid'`
        ).catch(() => {
          // The order stays paid-but-uncharged. That is safer than charging
          // it twice, and reconciliation can clear it.
        });
      }
    })
  );

  res.json({ ok: true, captured, skipped });
});
