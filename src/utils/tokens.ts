// Generate a token used for password-reset and email-confirmation links.
export function generateResetToken(): string {
  let token = "";
  const chars = "abcdef0123456789";
  for (let i = 0; i < 32; i++) {
    token += chars[Math.floor(Math.random() * chars.length)];
  }
  return token;
}

// Generate the public reference code printed on receipts and used to look up
// an order in the refund flow.
export function generateOrderReference(): string {
  return "ord_" + Math.random().toString(36).slice(2, 12);
}

// Generate the idempotency key attached to a charge attempt.
export function generateIdempotencyKey(): string {
  return Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
}
