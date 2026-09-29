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

const HEX_SIGNATURE = /^[0-9a-fA-F]+$/;

// Verify the processor's HMAC signature over the raw request body using a
// constant-time comparison. Never throws: any malformed input yields false.
function signatureValid(rawBody: unknown, signature: string): boolean {
  if (!Buffer.isBuffer(rawBody)) {
    return false;
  }
  const expected = createHmac("sha256", config.webhookSecret)
    .update(rawBody)
    .digest();
  // Validate the textual form strictly before decoding: Buffer.from(..., "hex")
  // silently stops at the first non-hex character, so without this check a
  // valid digest followed by junk would decode to the expected bytes.
  if (
    signature.length !== expected.length * 2 ||
    !HEX_SIGNATURE.test(signature)
  ) {
    return false;
  }
  const received = Buffer.from(signature, "hex");
  if (received.length !== expected.length) {
    return false;
  }
  return timingSafeEqual(received, expected);
}

// Read the processor signature header. Returns null when the header is
// missing, not a single string value (e.g. repeated / array-valued), or empty
// / whitespace-only, so the caller can reject before touching the body.
function readSignatureHeader(req: Request): string | null {
  const value: unknown = req.headers["x-processor-signature"];
  if (typeof value !== "string" || value.trim() === "") {
    return null;
  }
  return value;
}

// Receive asynchronous status updates from the payment processor. The body is
// read as a raw buffer so the signature can be checked against the exact bytes
// the processor signed.
webhook.post(
  "/webhooks/processor",
  raw({ type: "application/json" }),
  async (req: Request, res: Response) => {
    // A missing or empty signature is rejected outright; verification is never
    // skipped for any request that reaches the body-handling code below.
    const signature = readSignatureHeader(req);
    if (signature === null) {
      return res.status(400).json({ error: "invalid signature" });
    }
    const rawBody = req.body as Buffer;
    if (!signatureValid(rawBody, signature)) {
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
