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
// deterministic function of the order id alone: calling this for the same
// order id must always return the same string (even across retries that
// happen far apart in time, or after a process restart), while still
// differing between distinct orders.
export function chargeIdempotencyKey(orderId: string): string {
  const digest = createHash("sha256").update(orderId).digest("hex");
  return `charge_${digest}`;
}

// Generate an internal identifier (e.g. for a refund row).
export function newId(): string {
  return randomUUID();
}
