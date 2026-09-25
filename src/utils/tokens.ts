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
// The key must be a pure function of the order id: anything time- or
// randomness-derived would give each retry a fresh key and defeat the
// processor's de-duplication. An order is only charged while it is "pending",
// so one key per order is sufficient.
export function chargeIdempotencyKey(orderId: string): string {
  return `charge_${orderId}`;
}

// Generate an internal identifier (e.g. for a refund row).
export function newId(): string {
  return randomUUID();
}
