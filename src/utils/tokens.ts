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
// The key is a pure function of the order id: every retry for the same order
// (including one issued minutes later or from another process) must produce
// the identical key, otherwise the processor treats it as a new charge. Do not
// mix in time, randomness, or other per-call state here. An order is only
// ever captured once (pending -> paid), so scoping the key to the order is the
// right granularity, and the fixed prefix plus raw id keeps keys for distinct
// orders distinct.
export function chargeIdempotencyKey(orderId: string): string {
  return `charge_${orderId}`;
}

// Generate an internal identifier (e.g. for a refund row).
export function newId(): string {
  return randomUUID();
}
