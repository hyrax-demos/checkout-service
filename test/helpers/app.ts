// `src/index.ts` calls `app.listen` at import time (and has no exported
// `app`), so it cannot be imported directly in tests. This mirrors its
// mounting order exactly, without listening on a port, for tests to drive
// with supertest against a fresh express app per test file.
import express from "express";
import { orders } from "../../src/routes/orders";
import { payments } from "../../src/routes/payments";
import { admin } from "../../src/routes/admin";
import { webhook } from "../../src/routes/webhook";
import { authenticate, requireRole } from "../../src/middleware/authenticate";

export function buildApp() {
  const app = express();

  app.use(webhook);
  app.use(express.json());

  app.use("/orders", authenticate);
  app.use("/payments", authenticate);
  app.use("/refunds", authenticate);
  app.use("/admin", authenticate, requireRole("admin"));

  app.use(orders);
  app.use(payments);
  app.use(admin);

  app.get("/health", (_req, res) => res.json({ status: "ok" }));

  return app;
}
