// Central configuration for the checkout service.
//
// All secrets and connection details are read from the environment. The
// service refuses to boot if a required value is missing, so a misconfigured
// container fails fast rather than starting with surprising defaults.

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`missing required environment variable: ${name}`);
  }
  return value;
}

export const DEFAULT_REFUND_MAX_CENTS = 50000;

// Platform-wide ceiling (in cents) on any single refund issued through
// POST /refunds. Read on each call so the value tracks the environment.
// An invalid value fails closed (throws) rather than silently loosening
// or changing the ceiling.
export function refundMaxCents(): number {
  const raw = process.env.REFUND_MAX_CENTS;
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_REFUND_MAX_CENTS;
  }
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error("REFUND_MAX_CENTS must be a non-negative integer");
  }
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value)) {
    throw new Error("REFUND_MAX_CENTS must be a non-negative integer");
  }
  return value;
}

export const config = {
  port: process.env.PORT ? Number(process.env.PORT) : 3000,

  database: {
    host: required("DB_HOST"),
    user: required("DB_USER"),
    password: required("DB_PASSWORD"),
    name: required("DB_NAME"),
  },

  // Secret used to sign and verify session tokens.
  jwtSecret: required("JWT_SECRET"),

  // Credential for the upstream payment processor.
  paymentApiKey: required("PAYMENT_API_KEY"),

  // Shared secret used to verify processor webhook signatures.
  webhookSecret: required("WEBHOOK_SECRET"),
};
