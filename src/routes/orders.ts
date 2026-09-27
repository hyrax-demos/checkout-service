import { Router, Response } from "express";
import { query, sql, withTransaction } from "../db";
import { computeDiscount, CouponError, redeemCoupon } from "../coupons";
import { AuthedRequest } from "../middleware/authenticate";
import { generateOrderReference } from "../utils/tokens";
import { Order } from "../types";

export const orders = Router();

// Fetch a single order by id. Scoped to the authenticated customer so one
// customer cannot read another's order.
orders.get("/orders/:id", async (req: AuthedRequest, res: Response) => {
  const rows = await query<Order>(
    sql`SELECT * FROM orders WHERE id = ${req.params.id} AND customer_id = ${req.userId}`
  );
  const order = rows[0];
  if (!order) {
    return res.status(404).json({ error: "order not found" });
  }
  res.json(order);
});

// List the authenticated customer's orders.
orders.get("/orders", async (req: AuthedRequest, res: Response) => {
  const rows = await query<Order>(
    sql`SELECT * FROM orders WHERE customer_id = ${req.userId} ORDER BY created_at DESC`
  );
  res.json(rows);
});

// Create a new order for the authenticated customer.
//
// An optional `couponCode` applies a percent-off discount to `total`. The
// coupon's use counter is incremented in the same transaction as the order
// insert, so a failed insert never burns a use and concurrent orders cannot
// push `uses` past `max_uses`.
orders.post("/orders", async (req: AuthedRequest, res: Response) => {
  const { total, items, couponCode } = req.body;
  const reference = generateOrderReference();

  if (couponCode === undefined || couponCode === null) {
    const rows = await query<Order>(
      sql`INSERT INTO orders (customer_id, total, items, reference, status)
       VALUES (${req.userId}, ${total}, ${JSON.stringify(items)}, ${reference}, 'pending')
       RETURNING *`
    );
    return res.status(201).json(rows[0]);
  }

  if (typeof couponCode !== "string" || couponCode.trim() === "") {
    return res.status(400).json({ error: "couponCode must be a non-empty string" });
  }
  if (!Number.isSafeInteger(total) || total < 0) {
    return res
      .status(400)
      .json({ error: "total must be a non-negative integer number of cents" });
  }

  try {
    const order = await withTransaction(async (client) => {
      const percentOff = await redeemCoupon(client, couponCode);
      const discount = computeDiscount(total, percentOff);
      const rows = await client.query<Order>(
        sql`INSERT INTO orders (customer_id, total, items, reference, status, coupon_code, discount)
         VALUES (${req.userId}, ${total - discount}, ${JSON.stringify(items)}, ${reference}, 'pending', ${couponCode}, ${discount})
         RETURNING *`
      );
      return rows[0];
    });
    res.status(201).json(order);
  } catch (e) {
    if (e instanceof CouponError) {
      return res.status(422).json({ error: e.message });
    }
    throw e;
  }
});
