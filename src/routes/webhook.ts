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

const HEX_RE = /^[0-9a-fA-F]+$/;

// Verify the processor's HMAC signature over the raw request body, in constant
// time. Returns false (never throws) for any malformed signature.
export function signatureValid(rawBody: Buffer, signature: string): boolean {
  // A non-JSON content type leaves `raw()` without a Buffer body; treat that
  // as unverifiable rather than letting `update()` throw.
  if (!Buffer.isBuffer(rawBody)) {
    return false;
  }
  const expected = createHmac("sha256", config.webhookSecret)
    .update(rawBody)
    .digest("hex");
  // `Buffer.from(x, "hex")` silently drops invalid characters and a trailing
  // odd nibble, so validate the string itself before decoding. The length
  // check also guarantees equal-length buffers for `timingSafeEqual`, which
  // throws otherwise.
  if (
    typeof signature !== "string" ||
    signature.length !== expected.length ||
    !HEX_RE.test(signature)
  ) {
    return false;
  }
  try {
    return timingSafeEqual(
      Buffer.from(expected, "hex"),
      Buffer.from(signature, "hex")
    );
  } catch {
    return false;
  }
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
