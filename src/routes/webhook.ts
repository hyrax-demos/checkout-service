import { Router, Request, Response, raw } from "express";
import { query, sql } from "../db";
import { config } from "../config";
import { checkTimestamp, verifySignature } from "../utils/webhookSignature";
import { processedEvents } from "../processedEvents";
import { markPaid } from "../orders";

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
    if (typeof event.id !== "string" || event.id.length === 0) {
      return res.status(400).json({ error: "missing event id" });
    }

    // (4) Replay: an already-processed event is acknowledged without
    // re-running any side effects.
    if (await processedEvents.has(event.id)) {
      return res.json({ received: true, duplicate: true });
    }

    // (5) Handle the event.
    switch (event.type) {
      case "charge.succeeded": {
        // Only a 'pending' order may become 'paid'. An invalid transition
        // leaves the order untouched and is not recorded as processed. An
        // unknown order keeps the prior behaviour (acknowledged, no-op).
        const result = await markPaid(event.data.orderId as string);
        if (!result.ok && result.reason === "invalid_transition") {
          return res.status(409).json({ error: "order is not awaiting payment" });
        }
        break;
      }
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

    // (6) Record the id only after handling succeeded, so a failed attempt
    // (handler threw) stays retryable by the processor.
    await processedEvents.add(event.id);

    res.json({ received: true });
  }
);
