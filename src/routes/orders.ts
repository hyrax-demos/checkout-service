import { Router, Response, NextFunction } from "express";
import { query, sql } from "../db";
import { AuthedRequest } from "../middleware/authenticate";
import { generateOrderReference } from "../utils/tokens";
import { Order } from "../types";
import { cancelOrder } from "../services/orders";
import {
  NotFoundError,
  OrderNotCancellableError,
  PaymentFailedError,
} from "../errors";

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
orders.post("/orders", async (req: AuthedRequest, res: Response) => {
  const { total, items } = req.body;
  const reference = generateOrderReference();
  const rows = await query<Order>(
    sql`INSERT INTO orders (customer_id, total, items, reference, status)
     VALUES (${req.userId}, ${total}, ${JSON.stringify(items)}, ${reference}, 'pending')
     RETURNING *`
  );
  res.status(201).json(rows[0]);
});

// Cancel one of the authenticated customer's orders. A pending order is
// cancelled outright; a paid order is fully refunded first. All domain logic
// lives in `cancelOrder`; this handler only maps its typed errors to HTTP.
orders.post(
  "/orders/:id/cancel",
  async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const order = await cancelOrder({
        orderId: req.params.id,
        customerId: req.userId as string,
      });
      res.json(order);
    } catch (e) {
      if (e instanceof NotFoundError) {
        return res.status(404).json({ error: "order not found" });
      }
      if (e instanceof OrderNotCancellableError) {
        return res.status(409).json({ error: "order is not cancellable" });
      }
      if (e instanceof PaymentFailedError) {
        return res.status(402).json({ error: "refund declined" });
      }
      next(e);
    }
  }
);
