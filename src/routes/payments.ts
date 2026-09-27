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

type RowQuery = (q: SqlQuery) => Promise<Array<{ refunded?: unknown }>>;

class RefundExceedsTotalError extends Error {}

export interface RefundTotals {
  /** Sum of all refunds already recorded for the order, integer cents. */
  priorRefundedCents: number;
  /** priorRefundedCents plus the refund being requested, integer cents. */
  cumulativeRefundedCents: number;
  /** True when cumulativeRefundedCents would exceed the order's total. */
  exceedsTotal: boolean;
  /** True when cumulativeRefundedCents reaches (or passes) the order's total. */
  reachesTotal: boolean;
}

// Sum the refunds already issued against an order (integer cents; 0 if none).
// `run` is either the pooled `query` or a transaction client's `query`.
export async function sumRefundedCents(
  run: RowQuery,
  orderId: string
): Promise<number> {
  const rows = await run(
    sql`SELECT COALESCE(SUM(amount), 0) AS refunded FROM refunds WHERE order_id = ${orderId}`
  );
  // pg returns SUM over an integer column as a bigint string.
  return Number(rows[0]?.refunded ?? 0);
}

// Compute the prior/cumulative refunded totals for a prospective refund and
// whether it would exceed the order's captured total. Refunding exactly up to
// the total is allowed.
export async function checkRefundTotals(
  run: RowQuery,
  order: Pick<Order, "id" | "total">,
  amountCents: number
): Promise<RefundTotals> {
  const priorRefundedCents = await sumRefundedCents(run, order.id);
  const cumulativeRefundedCents = priorRefundedCents + amountCents;
  return {
    priorRefundedCents,
    cumulativeRefundedCents,
    exceedsTotal: cumulativeRefundedCents > order.total,
    reachesTotal: cumulativeRefundedCents >= order.total,
  };
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

  // A refund may not push the order's cumulative refunded amount past its
  // captured total (`order.total`, integer cents). This also covers a single
  // refund that alone exceeds the total (prior refunds = 0). This unlocked
  // read is a fast path that rejects obvious over-refunds without opening a
  // transaction; the authoritative check is repeated under a row lock below.
  const precheck = await checkRefundTotals(query, order, amountCents);
  if (precheck.exceedsTotal) {
    return res.status(422).json({ error: "refund exceeds order total" });
  }

  const refundId = newId();
  try {
    await withTransaction(async (client) => {
      // Lock the order row so concurrent refunds for the same order serialize
      // here: the sum below, the processor call and the insert then run
      // without another refund slipping in between (double-refund race).
      await client.query(
        sql`SELECT id FROM orders WHERE id = ${order.id} FOR UPDATE`
      );
      const totals = await checkRefundTotals(
        (q) => client.query(q),
        order,
        amountCents
      );
      if (totals.exceedsTotal) {
        throw new RefundExceedsTotalError();
      }

      await refundProcessor({
        orderId: order.id,
        amount: amountCents, // cents, per RefundArgs contract
        apiKey: config.paymentApiKey,
      });
      await client.query(
        sql`INSERT INTO refunds (id, order_id, amount) VALUES (${refundId}, ${order.id}, ${amountCents})`
      );
      // Only a refund that brings the cumulative refunded total up to the
      // captured total marks the order refunded; a partial refund leaves the
      // order's status untouched.
      if (totals.reachesTotal) {
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
