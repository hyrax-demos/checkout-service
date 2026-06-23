// Thin wrapper around the upstream payment processor's HTTP SDK.
//
// Every amount crossing this boundary is in integer cents, matching both our
// internal `Order.total` convention and the processor's API.

export class ProcessorError extends Error {}

export interface ChargeArgs {
  amount: number; // cents
  card?: unknown;
  apiKey: string;
  idempotencyKey: string;
}

export interface RefundArgs {
  orderId: string;
  amount: number; // cents
  apiKey: string;
}

// Capture a charge. In the real service this issues an authenticated POST to
// the processor; the demo build resolves immediately.
export async function chargeProcessor(_args: ChargeArgs): Promise<void> {
  return;
}

// Reverse a captured charge.
export async function refundProcessor(_args: RefundArgs): Promise<void> {
  return;
}
