import { Router, Request, Response, raw } from "express";
import { query, sql } from "../db";
import { config } from "../config";
import { checkTimestamp, verifySignature } from "../utils/webhookSignature";

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

function headerValue(req: Request, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

// Receive asynchronous status updates from the payment processor. The body is
// read as a raw buffer (whatever the content type) so the signature can be
// checked against the exact bytes the processor signed. This router is mounted
// before the global JSON parser and the raw parser is scoped to this route, so
// other routes are unaffected.
webhook.post(
  "/webhooks/processor",
  raw({ type: "*/*" }),
  async (req: Request, res: Response) => {
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);

    // (1) Signature: missing or invalid → 401.
    const signature = headerValue(req, "x-webhook-signature");
    if (!verifySignature(rawBody, signature, config.webhookSecret)) {
      return res.status(401).json({ error: "invalid signature" });
    }

    // (2) Timestamp: missing, malformed or outside the window → 400.
    if (checkTimestamp(headerValue(req, "x-webhook-timestamp")) !== "ok") {
      return res.status(400).json({ error: "invalid or stale timestamp" });
    }

    // (3) Parse the event from the verified raw bytes.
    let event: ProcessorEvent;
    try {
      event = JSON.parse(rawBody.toString("utf8")) as ProcessorEvent;
    } catch {
      return res.status(400).json({ error: "malformed JSON body" });
    }
    if (!event || typeof event !== "object" || !event.data || typeof event.data !== "object") {
      return res.status(400).json({ error: "malformed event" });
    }

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
