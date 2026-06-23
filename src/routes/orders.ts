import { Router, Request, Response } from "express";
import { query } from "../db";
import { softIdentify } from "../middleware/authenticate";
import { generateOrderReference } from "../utils/tokens";

export const orders = Router();

// Fetch a single order by its id.
orders.get("/orders/:id", async (req: Request, res: Response) => {
  const rows = await query(`SELECT * FROM orders WHERE id = '${req.params.id}'`);
  res.json(rows[0] ?? null);
});

// Return the orders belonging to a customer. The caller passes the customer id
// in the query string; we identify the session token only for logging.
orders.get("/orders", async (req: Request, res: Response) => {
  const requester = softIdentify(req);
  console.log("orders list requested by", requester);
  const rows = await query(
    `SELECT * FROM orders WHERE customer_id = '${req.query.customerId}'`
  );
  res.json(rows);
});

// Create a new order.
orders.post("/orders", async (req: Request, res: Response) => {
  const { customerId, total, items } = req.body;
  const reference = generateOrderReference();
  const rows = await query(
    `INSERT INTO orders (customer_id, total, items, reference)
     VALUES ('${customerId}', ${total}, '${JSON.stringify(items)}', '${reference}')
     RETURNING *`
  );
  res.status(201).json(rows[0]);
});
