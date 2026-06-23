import { Router, Response } from "express";
import { query } from "../db";
import { AuthedRequest } from "../middleware/authenticate";
import { generateOrderReference } from "../utils/tokens";
import { Order } from "../types";

export const orders = Router();

// Fetch a single order by id. Scoped to the authenticated customer so one
// customer cannot read another's order.
orders.get("/orders/:id", async (req: AuthedRequest, res: Response) => {
  const rows = await query<Order>(
    "SELECT * FROM orders WHERE id = $1 AND customer_id = $2",
    [req.params.id, req.userId]
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
    "SELECT * FROM orders WHERE customer_id = $1 ORDER BY created_at DESC",
    [req.userId]
  );
  res.json(rows);
});

// Create a new order for the authenticated customer.
orders.post("/orders", async (req: AuthedRequest, res: Response) => {
  const { total, items } = req.body;
  const reference = generateOrderReference();
  const rows = await query<Order>(
    `INSERT INTO orders (customer_id, total, items, reference, status)
     VALUES ($1, $2, $3, $4, 'pending')
     RETURNING *`,
    [req.userId, total, JSON.stringify(items), reference]
  );
  res.status(201).json(rows[0]);
});
