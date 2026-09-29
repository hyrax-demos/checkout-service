import { createHash, randomBytes, randomUUID } from "crypto";

// Generate a token used for password-reset and email-confirmation links.
export function generateResetToken(): string {
  return randomBytes(32).toString("hex");
}

// Generate the public reference code printed on receipts and used to look up
// an order in the refund flow.
export function generateOrderReference(): string {
  return "ord_" + randomBytes(8).toString("hex");
}

// Build the idempotency key sent to the processor with a charge attempt. The
// processor collapses charges that share a key, so retries of the same attempt
// do not double-charge the customer. The key must therefore be a pure,
// deterministic function of the order id: calling this again for the same
// order (e.g. on a retry, possibly much later or in a different process)
// has to reproduce the exact same string, while different orders must still
// map to different keys.
export function chargeIdempotencyKey(orderId: string): string {
  const digest = createHash("sha256").update(orderId).digest("hex");
  return `charge_${orderId}_${digest}`;
}

// Generate an internal identifier (e.g. for a refund row).
export function newId(): string {
  return randomUUID();
}
