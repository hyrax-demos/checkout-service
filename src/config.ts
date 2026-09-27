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

// Platform-wide ceiling on a single refund, in integer cents, used when
// REFUND_MAX_CENTS is unset or empty ($500.00).
export const DEFAULT_REFUND_MAX_CENTS = 50000;

// Parse REFUND_MAX_CENTS. Unset/empty falls back to the default; anything
// other than a non-negative integer number of cents is rejected rather than
// silently ignored, since a NaN ceiling would compare false and disable the
// limit entirely.
export function parseRefundMaxCents(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_REFUND_MAX_CENTS;
  }
  const trimmed = raw.trim();
  const value = Number(trimmed);
  if (!/^\d+$/.test(trimmed) || !Number.isSafeInteger(value)) {
    throw new Error(
      `invalid REFUND_MAX_CENTS: expected a non-negative integer number of cents, got ${JSON.stringify(raw)}`
    );
  }
  return value;
}

// Validate at boot so a misconfigured ceiling fails fast like other settings.
parseRefundMaxCents(process.env.REFUND_MAX_CENTS);

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

  // Maximum amount (cents) of any single refund issued via POST /refunds.
  // Applied in addition to the order-total limit, never instead of it.
  get refundMaxCents(): number {
    return parseRefundMaxCents(process.env.REFUND_MAX_CENTS);
  },
};
