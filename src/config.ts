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

// Parse the refund ceiling from its raw environment value. Unset or empty
// falls back to the default. Anything that is not a non-negative integer
// number of cents is rejected: a malformed value must never silently disable
// the ceiling (e.g. `NaN` comparisons are always false).
export function parseRefundMaxCents(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_REFUND_MAX_CENTS;
  }
  const trimmed = raw.trim();
  const value = Number(trimmed);
  if (!/^\d+$/.test(trimmed) || !Number.isSafeInteger(value)) {
    throw new Error(
      `invalid REFUND_MAX_CENTS: expected a non-negative integer number of cents, got "${raw}"`
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

  // Platform-wide maximum for a single refund via `POST /refunds`, in cents.
  // Read from `REFUND_MAX_CENTS` (default 50000 = $500.00). Applied in
  // addition to the per-order captured-total limit, never instead of it.
  get refundMaxCents(): number {
    return parseRefundMaxCents(process.env.REFUND_MAX_CENTS);
  },
};
