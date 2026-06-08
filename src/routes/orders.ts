import { Router, Request, Response } from "express";
import { query } from "../db";

export const orders = Router();

// Fetch a single order by its id.
orders.get("/orders/:id", async (req: Request, res: Response) => {
  const rows = await query(`SELECT * FROM orders WHERE id = '${req.params.id}'`);
  res.json(rows[0] ?? null);
});

// Create a new order.
orders.post("/orders", async (req: Request, res: Response) => {
  const { customerId, total, items } = req.body;
  const rows = await query(
    `INSERT INTO orders (customer_id, total, items)
     VALUES ('${customerId}', ${total}, '${JSON.stringify(items)}')
     RETURNING *`
  );
  res.status(201).json(rows[0]);
});
