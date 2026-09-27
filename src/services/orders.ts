import { sql, withTransaction } from "../db";
import { config } from "../config";
import { newId } from "../utils/tokens";
import { Order } from "../types";
import { refundProcessor, ProcessorError } from "../processor";
import {
  NotFoundError,
  OrderNotCancellableError,
  PaymentFailedError,
} from "../errors";

export interface CancelOrderArgs {
  orderId: string;
  customerId: string;
}

// The refund issued when a paid order is cancelled. `amount` is integer cents.
export interface CancelRefund {
  id: string;
  amount: number;
}

// A cancelled order. `refund` is present only when a paid order was refunded.
export type CancelledOrder = Order & { refund?: CancelRefund };

// Cancel one of a customer's orders.
//
// - pending: flipped to 'cancelled'; no processor call, no refund row.
// - paid: the full captured total is refunded through the processor first;
//   only once that succeeds is the refund row recorded and the order flipped
//   to 'cancelled'. The result carries `refund: { id, amount }` (cents).
//   A `ProcessorError` surfaces as `PaymentFailedError` with
//   nothing written.
// - any other status: `OrderNotCancellableError`.
// - missing, or owned by another customer: `NotFoundError` (indistinguishable).
//
// Everything runs in one transaction. The order row is locked (`FOR UPDATE`)
// up front so two concurrent cancels of the same paid order cannot both pass
// the status check and refund it twice; a thrown error rolls back every
// write, leaving the order's status unchanged.
export async function cancelOrder({
  orderId,
  customerId,
}: CancelOrderArgs): Promise<CancelledOrder> {
  return withTransaction(async (client) => {
    const rows = await client.query<Order>(
      sql`SELECT * FROM orders WHERE id = ${orderId} AND customer_id = ${customerId} FOR UPDATE`
    );
    const order = rows[0];
    if (!order) {
      throw new NotFoundError("order not found");
    }

    if (order.status === "pending") {
      const updated = await client.query<Order>(
        sql`UPDATE orders SET status = 'cancelled' WHERE id = ${order.id} RETURNING *`
      );
      return updated[0];
    }

    if (order.status !== "paid") {
      throw new OrderNotCancellableError(order.status);
    }

    // `Order.total` is already integer cents. `pg` may hand back numeric /
    // bigint columns as strings, so normalise and refuse anything that isn't
    // a positive integer rather than sending the processor a bad amount.
    const amountCents = Number(order.total);
    if (!Number.isSafeInteger(amountCents) || amountCents <= 0) {
      throw new Error(`order ${order.id} has an invalid total: ${order.total}`);
    }

    try {
      await refundProcessor({
        orderId: order.id,
        amount: amountCents,
        apiKey: config.paymentApiKey,
      });
    } catch (e) {
      if (e instanceof ProcessorError) {
        throw new PaymentFailedError("refund declined by processor", e);
      }
      throw e;
    }

    // The processor has no refund reference in its current API, so the row
    // records our own id alongside the order and amount.
    const refundId = newId();
    await client.query(
      sql`INSERT INTO refunds (id, order_id, amount) VALUES (${refundId}, ${order.id}, ${amountCents})`
    );
    const updated = await client.query<Order>(
      sql`UPDATE orders SET status = 'cancelled' WHERE id = ${order.id} RETURNING *`
    );
    return { ...updated[0], refund: { id: refundId, amount: amountCents } };
  });
}
