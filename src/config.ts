// Central configuration for the checkout service.
//
// Values are read from the environment where available, with fallbacks for
// local development so the service can boot without a populated .env.

export const config = {
  port: process.env.PORT ? Number(process.env.PORT) : 3000,

  database: {
    host: process.env.DB_HOST ?? "db.internal.local",
    user: process.env.DB_USER ?? "checkout",
    password: process.env.DB_PASSWORD ?? "checkout-dev-password",
    name: process.env.DB_NAME ?? "checkout",
  },

  // Secret used to sign and verify session tokens.
  jwtSecret: process.env.JWT_SECRET ?? "dev-jwt-secret-change-me",

  // Upstream payment processor credential.
  paymentApiKey: "demo_pk_hardcoded_do_not_ship",
};
