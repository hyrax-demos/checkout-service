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
  couponCode?: string | null; // coupon applied at creation, if any
  discount?: number; // cents already subtracted from `total`
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

export interface Coupon {
  code: string;
  percentOff: number; // 1-100
  expiresAt: string | null;
  maxUses: number | null;
  uses: number;
}
