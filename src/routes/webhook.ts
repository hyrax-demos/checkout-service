import { Router, Request, Response, raw } from "express";
import { query, sql } from "../db";
import { config } from "../config";
import { checkTimestamp, verifySignature } from "../utils/webhookSignature";
import { processedEvents } from "../processedEvents";
import { markPaid } from "../orders";
import {
  webhookEventLog,
  WebhookEventLogEntry,
  WebhookOutcome,
} from "../webhookEventLog";

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

type DeliveryResult = {
  status: number;
  body: Record<string, unknown>;
  outcome: WebhookOutcome;
  reason: string | null;
};

// Pull log fields from a signature-verified body. Only string values are kept,
// so a malformed payload cannot put arbitrary structures into the log.
function logFields(event: unknown): Pick<WebhookEventLogEntry, "event_id" | "type" | "order_id"> {
  const e = (event && typeof event === "object" ? event : {}) as Record<string, any>;
  const str = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : null);
  const data = e.data && typeof e.data === "object" ? e.data : {};
  return { event_id: str(e.id), type: str(e.type), order_id: str(data.orderId) };
}

function tryParse(rawBody: Buffer): unknown {
  try {
    return JSON.parse(rawBody.toString("utf8"));
  } catch {
    return undefined;
  }
}

const reject = (status: number, error: string, reason: string): DeliveryResult => ({
  status,
  body: { error },
  outcome: "rejected",
  reason,
});

// Run the checks and side effects for one delivery and describe the result.
// It never writes the response or the event log; the route handler owns both,
// so every exit path is logged exactly once.
// `signed` is the result of verifying the raw body's signature, and `parsed`
// is that body parsed as JSON (undefined when unsigned or not valid JSON).
async function processDelivery(
  req: Request,
  signed: boolean,
  parsed: unknown
): Promise<DeliveryResult> {
  // (1) Signature: missing or invalid → 401.
  if (!signed) {
    return reject(401, "invalid signature", "invalid_signature");
  }

  // (2) Timestamp: missing, malformed or outside the window → 400.
  const timestamp = checkTimestamp(headerValue(req, "x-webhook-timestamp"));
  if (timestamp !== "ok") {
    return reject(400, "invalid or stale timestamp", `${timestamp}_timestamp`);
  }

  // (3) Parse the event from the verified raw bytes.
  if (parsed === undefined) {
    return reject(400, "malformed JSON body", "malformed_json");
  }
  const event = parsed as ProcessorEvent;
  if (!event || typeof event !== "object" || !event.data || typeof event.data !== "object") {
    return reject(400, "malformed event", "malformed_event");
  }
  if (typeof event.id !== "string" || event.id.length === 0) {
    return reject(400, "missing event id", "missing_event_id");
  }

  // (4) Replay: claim the id atomically before any side effect runs.
  // Checking and reserving in one step means two concurrent deliveries of
  // the same event cannot both get past this point.
  const claim = await processedEvents.begin(event.id);
  if (claim === "done") {
    return {
      status: 200,
      body: { received: true, duplicate: true },
      outcome: "duplicate",
      reason: "already_processed",
    };
  }
  if (claim === "in_progress") {
    // A concurrent delivery owns this id. Answer non-2xx so the processor
    // retries later: it then sees "done", or can claim the id itself if
    // the other attempt failed.
    return reject(409, "event is already being processed", "in_progress");
  }

  // (5) Handle the event. (6) Record the id as processed only if handling
  // succeeded. On any other exit (409 or a thrown error) the claim is
  // released so the processor can retry the delivery.
  let handled = false;
  try {
    const rejection = await handleEvent(event);
    if (rejection) {
      return reject(rejection.status, rejection.error, "invalid_transition");
    }
    await processedEvents.complete(event.id);
    handled = true;
  } finally {
    if (!handled) await processedEvents.release(event.id);
  }

  return { status: 200, body: { received: true }, outcome: "processed", reason: null };
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
    const receivedAt = new Date().toISOString();
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);

    // Event fields are logged only when the signature is valid, so an
    // unauthenticated caller cannot plant arbitrary ids in the admin log.
    const signed = verifySignature(
      rawBody,
      headerValue(req, "x-webhook-signature"),
      config.webhookSecret
    );
    const parsed = signed ? tryParse(rawBody) : undefined;
    const fields = signed
      ? logFields(parsed)
      : { event_id: null, type: null, order_id: null };

    let result: DeliveryResult;
    try {
      result = await processDelivery(req, signed, parsed);
    } catch (err) {
      await webhookEventLog.record({
        ...fields,
        outcome: "rejected",
        reason: "handler_error",
        status: 500,
        received_at: receivedAt,
      });
      throw err;
    }

    await webhookEventLog.record({
      ...fields,
      outcome: result.outcome,
      reason: result.reason,
      status: result.status,
      received_at: receivedAt,
    });
    res.status(result.status).json(result.body);
  }
);
