// Order state-machine transitions. Status changes go through here so the
// allowed-from-state check cannot be skipped by an individual caller.
import { query, sql } from "./db";
import { OrderStatus } from "./types";

export type TransitionResult =
  | { ok: true }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "invalid_transition"; from: OrderStatus };

// Move an order to 'paid', but only from 'pending'. The check and the update
// are a single conditional UPDATE, so concurrent callers cannot both win.
export async function markPaid(orderId: string): Promise<TransitionResult> {
  const updated = await query<{ id: string }>(
    sql`UPDATE orders SET status = 'paid' WHERE id = ${orderId} AND status = 'pending' RETURNING id`
  );
  if (updated.length > 0) return { ok: true };

  // Nothing changed: work out whether the order is missing or in another state.
  const rows = await query<{ status: OrderStatus }>(
    sql`SELECT status FROM orders WHERE id = ${orderId}`
  );
  if (rows.length === 0) return { ok: false, reason: "not_found" };
  return { ok: false, reason: "invalid_transition", from: rows[0].status };
}
