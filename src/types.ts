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

// `processing` is a transient state: a charge request has atomically claimed
// the order and a processor call is in flight. It returns to `pending` if the
// charge fails, or moves on to `paid` if it succeeds.
export type OrderStatus =
  | "pending"
  | "processing"
  | "paid"
  | "cancelled"
  | "refunded";
