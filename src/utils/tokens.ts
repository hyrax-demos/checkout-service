import { randomBytes, randomUUID } from "crypto";

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
// do not double-charge the customer.
//
// The key must be a pure function of the order id: an order is captured at
// most once (pending -> paid), so every retry of that capture — whether a
// client resend or a later batch run — must present the same key. Never mix
// in time, randomness, or other per-call state here.
export function chargeIdempotencyKey(orderId: string): string {
  return `charge_${orderId}`;
}

// Generate an internal identifier (e.g. for a refund row).
export function newId(): string {
  return randomUUID();
}
