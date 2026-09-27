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

// Default platform-wide ceiling on a single refund, in cents ($500.00).
export const DEFAULT_REFUND_MAX_CENTS = 50000;

// Parse REFUND_MAX_CENTS (integer cents). Unset or empty falls back to the
// default; anything that is not a non-negative integer is a misconfiguration
// and is rejected rather than silently ignored.
function refundMaxCents(): number {
  const raw = process.env.REFUND_MAX_CENTS;
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_REFUND_MAX_CENTS;
  }
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(
      `invalid REFUND_MAX_CENTS: expected a non-negative integer number of cents, got "${raw}"`
    );
  }
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value)) {
    throw new Error(`invalid REFUND_MAX_CENTS: value out of range: "${raw}"`);
  }
  return value;
}

// Validate at boot so a malformed value fails fast like the other settings.
refundMaxCents();

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

  // Platform-wide ceiling on any single refund issued via POST /refunds, in
  // cents. Applied on top of (never instead of) the order-total limit. Read on
  // access so the current environment value is always honoured.
  get refundMaxCents(): number {
    return refundMaxCents();
  },
};
