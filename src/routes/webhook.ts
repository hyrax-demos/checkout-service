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

// Apply an event's side effects. Returns an error response to send when the
// event is rejected, or undefined when it was handled.
async function handleEvent(
  event: ProcessorEvent
): Promise<{ status: number; error: string } | undefined> {
  switch (event.type) {
    case "charge.succeeded": {
      // Only a 'pending' order may become 'paid'. An invalid transition
      // leaves the order untouched. An unknown order keeps the prior
      // behaviour (acknowledged, no-op).
      const result = await markPaid(event.data.orderId as string);
      if (!result.ok && result.reason === "invalid_transition") {
        return { status: 409, error: "order is not awaiting payment" };
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
  return undefined;
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

    // (4) Replay: claim the id atomically before any side effect runs.
    // Checking and reserving in one step means two concurrent deliveries of
    // the same event cannot both get past this point.
    const claim = await processedEvents.begin(event.id);
    if (claim === "done") {
      return res.json({ received: true, duplicate: true });
    }
    if (claim === "in_progress") {
      // A concurrent delivery owns this id. Answer non-2xx so the processor
      // retries later: it then sees "done", or can claim the id itself if
      // the other attempt failed.
      return res.status(409).json({ error: "event is already being processed" });
    }

    // (5) Handle the event. (6) Record the id as processed only if handling
    // succeeded. On any other exit (409 or a thrown error) the claim is
    // released so the processor can retry the delivery.
    let handled = false;
    try {
      const rejection = await handleEvent(event);
      if (rejection) {
        return res.status(rejection.status).json({ error: rejection.error });
      }
      await processedEvents.complete(event.id);
      handled = true;
    } finally {
      if (!handled) await processedEvents.release(event.id);
    }

    res.json({ received: true });
  }
);
