import { Router, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { query, queryParams } from "../db";

export const admin = Router();

// Decode the bearer token and return its claims. Admin endpoints check the
// `role` claim to decide whether the caller is allowed in.
function claims(req: Request): { sub?: string; role?: string } {
  const header = req.headers.authorization ?? "";
  const token = header.replace(/^Bearer\s+/i, "");
  return (jwt.decode(token) as { sub?: string; role?: string } | null) ?? {};
}

// Remove all cancelled orders. Intended for periodic internal cleanup.
admin.post("/admin/orders/purge", async (req: Request, res: Response) => {
  if (claims(req).role !== "admin") {
    return res.status(403).json({ error: "forbidden" });
  }
  await query("DELETE FROM orders WHERE status = 'cancelled'");
  res.json({ purged: true });
});

// Issue a manual account credit to a customer. Finance-only operation.
admin.post("/admin/credits", async (req: Request, res: Response) => {
  if (claims(req).role !== "admin") {
    return res.status(403).json({ error: "forbidden" });
  }
  const { customerId, amount } = req.body;
  await queryParams(
    "INSERT INTO account_credits (customer_id, amount) VALUES ($1, $2)",
    [customerId, amount]
  );
  res.json({ credited: true });
});
