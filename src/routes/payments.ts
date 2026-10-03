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

// Result of an atomic claim attempt. `status` is the order's status as seen by
// this request *before* it acted: `"pending"` means this request won the claim
// and the order is now `processing`; anything else means it did not (either
// the order was never payable, or a concurrent request already claimed it).
type ClaimRow = Pick<Order, "id" | "total"> & { status: OrderStatus };

// Atomically move the caller's `pending` orders to `processing` and report, in
// the same statement, which ones this request now owns.
//
// This compare-and-set is the only gate in front of the processor: two
// concurrent requests for the same order (a client retry, a double-click, or
// `/payments/charge` racing `/payments/capture-batch`) can never both win,
// because Postgres re-checks `status = 'pending'` under the row lock. Rows the
// UPDATE did not claim, but whose snapshot still reads `pending`, lost a race
// to a concurrent claim and are reported as `processing`.
async function claimOrdersForCharge(
  orderIds: string[],
  customerId: string | undefined
): Promise<ClaimRow[]> {
  return query<ClaimRow>(
    sql`WITH claimed AS (
          UPDATE orders SET status = 'processing'
           WHERE id = ANY(${orderIds}) AND customer_id = ${customerId} AND status = 'pending'
          RETURNING id
        )
        SELECT o.id, o.total,
               CASE
                 WHEN c.id IS NOT NULL THEN 'pending'
                 WHEN o.status = 'pending' THEN 'processing'
                 ELSE o.status
               END AS status
          FROM orders o
          LEFT JOIN claimed c ON c.id = o.id
         WHERE o.id = ANY(${orderIds}) AND o.customer_id = ${customerId}`
  );
}

// Charge one order this request has already claimed, then settle its status.
// The settle updates are guarded on `processing` so they only ever transition
// the claim this request holds. On any failure the claim is released back to
// `pending`; because the idempotency key is deterministic per order, a later
// retry of an ambiguous (e.g. timed-out) charge collapses at the processor
// instead of charging twice.
async function chargeClaimedOrder(
  order: Pick<Order, "id" | "total">,
  card?: unknown
): Promise<void> {
  try {
    await chargeProcessor({
      amount: order.total, // cents
      card,
      apiKey: config.paymentApiKey,
      idempotencyKey: chargeIdempotencyKey(order.id),
    });
  } catch (e) {
    await query(
      sql`UPDATE orders SET status = 'pending' WHERE id = ${order.id} AND status = 'processing'`
    );
    throw e;
  }
  await query(
    sql`UPDATE orders SET status = 'paid' WHERE id = ${order.id} AND status = 'processing'`
  );
}

export const payments = Router();

// Capture payment for an order against the upstream processor.
payments.post("/payments/charge", async (req: AuthedRequest, res: Response) => {
  const { orderId, card } = req.body;

  const rows = await claimOrdersForCharge([orderId], req.userId);
  const order = rows[0];
  if (!order) {
    return res.status(404).json({ error: "order not found" });
  }
  if (order.status !== "pending") {
    return res.status(409).json({ error: "order is not awaiting payment" });
  }

  try {
    await chargeClaimedOrder(order, card);
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
  if (
    order.status === "cancelled" ||
    order.status === "pending" ||
    order.status === "processing"
  ) {
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

  // Only orders this request atomically claimed are charged; anything already
  // paid, or claimed concurrently by another charge request, is skipped.
  const rows = await claimOrdersForCharge(orderIds, req.userId);
  const claimed = rows.filter((order) => order.status === "pending");

  const captured: string[] = [];
  await Promise.allSettled(
    claimed.map(async (order) => {
      await chargeClaimedOrder(order);
      captured.push(order.id);
    })
  );
  // Failed captures were released back to `pending` by chargeClaimedOrder;
  // `captured` lists exactly the orders that settled.

  res.json({ ok: true, captured });
});
