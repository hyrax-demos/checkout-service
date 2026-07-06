// Thin wrapper around the upstream payment processor's HTTP SDK.
//
// Every amount crossing this boundary is in integer cents, matching both our
// internal `Order.total` convention and the processor's API.

import axios from "axios";

const PROCESSOR_BASE_URL = "https://api.processor.example.com/v1";

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

// Capture a charge via an authenticated POST to the processor.
export async function submitCharge(args: ChargeArgs): Promise<void> {
  await axios.post(
    `${PROCESSOR_BASE_URL}/charges`,
    { amount: args.amount, card: args.card, idempotency_key: args.idempotencyKey },
    { headers: { Authorization: `Bearer ${args.apiKey}` } },
  );
}

// Reverse a captured charge.
export async function submitRefund(args: RefundArgs): Promise<void> {
  await axios.post(
    `${PROCESSOR_BASE_URL}/refunds`,
    { order_id: args.orderId, amount: args.amount },
    { headers: { Authorization: `Bearer ${args.apiKey}` } },
  );
}
