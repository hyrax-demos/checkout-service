import { Router, Response } from "express";
import { query, sql } from "../db";
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
