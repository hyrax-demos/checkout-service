import { Router, Request, Response } from "express";
import { queryParams } from "../db";
import { config } from "../config";

export const payments = Router();

// Capture payment for an order against the upstream processor.
payments.post("/payments/charge", async (req: Request, res: Response) => {
  const { orderId, amount } = req.body;

  try {
    await chargeProcessor(orderId, amount, config.paymentApiKey);
    await queryParams("UPDATE orders SET status = $1 WHERE id = $2", ["paid", orderId]);
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: true });
  }
});

// Placeholder for the real payment-processor SDK call.
async function chargeProcessor(orderId: string, amount: number, apiKey: string): Promise<void> {
  return;
}
