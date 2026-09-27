import { Router, Request, Response, NextFunction, raw } from "express";
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

// Reject any request that does not carry exactly one non-blank signature
// header. This runs before the body parser, so an unsigned request is turned
// away before its body is read, parsed or used, and before any write.
function requireSignatureHeader(
  req: Request,
  res: Response,
  next: NextFunction
) {
  // Node joins repeated custom headers into one comma-separated string, so
  // use `headersDistinct` to require exactly one occurrence.
  const values = req.headersDistinct["x-processor-signature"];
  const header = values?.length === 1 ? values[0] : undefined;
  if (typeof header !== "string" || header.trim() === "") {
    return res.status(400).json({ error: "missing signature" });
  }
  res.locals.signature = header;
  next();
}

// Receive asynchronous status updates from the payment processor. The body is
// read as a raw buffer so the signature can be checked against the exact bytes
// the processor signed.
webhook.post(
  "/webhooks/processor",
  requireSignatureHeader,
  raw({ type: "application/json" }),
  async (req: Request, res: Response) => {
    const signature = res.locals.signature as string;
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
