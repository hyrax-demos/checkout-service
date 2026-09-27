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

// Platform-wide ceiling (in cents) on the size of a single refund issued
// through POST /refunds. Finance can tune this per-environment; when unset
// or empty it defaults to $500.00. This is a ceiling on top of the existing
// per-order rule (a refund may never exceed the order's captured total) —
// whichever limit is lower still applies.
function refundMaxCents(): number {
  const raw = process.env.REFUND_MAX_CENTS;
  if (raw === undefined || raw === "") {
    return 50000;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error("REFUND_MAX_CENTS must be an integer number of cents");
  }
  return parsed;
}

export const config = {
  port: process.env.PORT ? Number(process.env.PORT) : 3000,

  refundMaxCents: refundMaxCents(),

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
