// Domain types for the checkout service.

export interface Order {
  id: string;
  customerId: string;
  total: number;
  items: OrderItem[];
  status: OrderStatus;
  reference: string;
  createdAt: string;
}

export interface OrderItem {
  sku: string;
  quantity: number;
  unitPrice: number;
}

export type OrderStatus = "pending" | "paid" | "cancelled" | "refunded";
