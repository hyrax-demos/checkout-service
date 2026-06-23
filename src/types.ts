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
