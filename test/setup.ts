// Test-only environment. `src/config.ts` throws at import time if any of
// these are unset, so they must be in place before any test imports a module
// that (transitively) imports "../config". Vitest runs `setupFiles` before
// loading test files, which is early enough.
process.env.PORT ??= "3000";
process.env.DB_HOST ??= "localhost";
process.env.DB_USER ??= "test";
process.env.DB_PASSWORD ??= "test";
process.env.DB_NAME ??= "test";
process.env.JWT_SECRET ??= "test-jwt-secret";
process.env.PAYMENT_API_KEY ??= "test-payment-api-key";
process.env.WEBHOOK_SECRET ??= "test-webhook-secret";
