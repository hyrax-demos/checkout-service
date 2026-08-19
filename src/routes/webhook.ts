import { Router, Request, Response, raw } from "express";
import { createHmac, timingSafeEqual } from "crypto";
import { query, sql } from "../db";
import { config } from "../config";

export const webhook = Router();

interface ProcessorEvent {
  id: string;
  type: string;
  data: {
    orderId?: string;
    customerId?: string;
    amount?: number;
  };
}

// Verify the processor's HMAC signature over the raw request body.
function signatureValid(rawBody: Buffer, signature: string): boolean {
  const expected = createHmac("sha256", config.webhookSecret)
    .update(rawBody)
    .digest("hex");
  const a = Buffer.from(signature, "hex");
  const b = Buffer.from(expected, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

// Receive asynchronous status updates from the payment processor. The body is
// read as a raw buffer so the signature can be checked against the exact bytes
// the processor signed.
webhook.post(
  "/webhooks/processor",
  raw({ type: "application/json" }),
  async (req: Request, res: Response) => {
    const signature = String(req.headers["x-processor-signature"] ?? "");
    const rawBody = req.body as Buffer;

    if (!signature || !signatureValid(rawBody, signature)) {
      return res.status(400).json({ error: "invalid signature" });
    }

    const event = JSON.parse(rawBody.toString("utf8")) as ProcessorEvent;

    switch (event.type) {
      case "charge.succeeded":
        await query(
          sql`UPDATE orders SET status = 'paid' WHERE id = ${event.data.orderId}`
        );
        break;
      case "charge.refunded":
        await query(
          sql`UPDATE orders SET status = 'refunded' WHERE id = ${event.data.orderId}`
        );
        break;
      case "credit.issued":
        // The processor applies a goodwill credit to the customer's balance;
        // mirror it into our account_credits ledger.
        await query(
          sql`INSERT INTO account_credits (customer_id, amount) VALUES (${event.data.customerId}, ${event.data.amount})`
        );
        break;
    }

    res.json({ received: true });
  }
);
