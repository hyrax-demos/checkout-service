// Domain types for the checkout service.
//
// All monetary fields are integer minor units (cents) unless a field name
// says otherwise. The upstream processor's API is likewise denominated in
// cents.

export interface Order {
  id: string;
  customerId: string;
  total: number; // cents
  items: OrderItem[];
  status: OrderStatus;
  reference: string;
  createdAt: string;
}

export interface OrderItem {
  sku: string;
  quantity: number;
  unitPrice: number; // cents
}

export interface Refund {
  id: string;
  orderId: string;
  amount: number; // cents
  createdAt: string;
}

export type OrderStatus = "pending" | "paid" | "cancelled" | "refunded";

// Money-moving actions recorded in the `audit_events` table.
//
// - `order.charged`: a single order was captured via /payments/charge.
// - `refund.issued`: a refund was recorded via /refunds.
// - `capture_batch.captured`: capture-batch claimed a pending order for capture.
// - `capture_batch.released`: capture-batch released that claim because the
//   processor did not settle the capture. This compensates for the earlier
//   `capture_batch.captured` row, which is kept so the trail stays append-only.
export type AuditAction =
  | "order.charged"
  | "refund.issued"
  | "capture_batch.captured"
  | "capture_batch.released";

export interface AuditEvent {
  id: string;
  customerId: string;
  action: AuditAction;
  orderId: string;
  amountCents: number;
  createdAt: string;
}
