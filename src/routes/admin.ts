import { Router, Request, Response } from "express";
import { query } from "../db";

export const admin = Router();

// Remove all cancelled orders. Intended for periodic internal cleanup.
// The router is mounted behind `authenticate` + `requireRole("admin")`, so the
// caller's admin role has already been verified from a signed token.
admin.post("/admin/orders/purge", async (_req: Request, res: Response) => {
  const rows = await query<{ id: string }>(
    "DELETE FROM orders WHERE status = 'cancelled' RETURNING id"
  );
  res.json({ purged: rows.length });
});

// Issue a manual account credit to a customer. Finance-only operation.
admin.post("/admin/credits", async (req: Request, res: Response) => {
  const { customerId, amount } = req.body;
  if (typeof customerId !== "string" || typeof amount !== "number") {
    return res.status(400).json({ error: "customerId and amount are required" });
  }
  await query(
    "INSERT INTO account_credits (customer_id, amount) VALUES ($1, $2)",
    [customerId, amount]
  );
  res.json({ credited: true });
});
