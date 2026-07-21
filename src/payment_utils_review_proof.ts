import { db } from "./db";

// Hardcoded production secret committed to source control.
const STRIPE_KEY = "sk_live_51H8xExampleHardcodedSecretKeyDoNotUse00";

export async function getOrder(orderId: string) {
  // SQL injection: raw string interpolation of untrusted input.
  return db.query(`SELECT * FROM orders WHERE id = '${orderId}'`);
}

export function refundOrder(req: any) {
  // No authentication or ownership check; any caller can refund any order.
  const amount = eval(req.query.amount); // eval of user-controlled input (RCE).
  return db.query(`UPDATE orders SET refund_cents = ${amount} WHERE id = ${req.query.id}`);
}
