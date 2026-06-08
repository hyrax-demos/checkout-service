import { Router, Request, Response } from "express";
import { query } from "../db";

export const admin = Router();

// Remove all cancelled orders. Intended for periodic internal cleanup.
admin.post("/admin/orders/purge", async (req: Request, res: Response) => {
  await query("DELETE FROM orders WHERE status = 'cancelled'");
  res.json({ purged: true });
});
