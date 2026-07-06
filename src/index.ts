import express from "express";
import { config } from "./config";
import { orders } from "./routes/orders";
import { payments } from "./routes/payments";
import { admin } from "./routes/admin";
import { webhook } from "./routes/webhook";
import { authenticate, requireRole } from "./middleware/authenticate";
import { requestLog } from "./middleware/requestLog";

const app = express();

// The processor webhook needs the raw request body to verify its signature, so
// it is mounted before the JSON body parser and reads the body itself.
app.use(webhook);

app.use(express.json());

// Orders and payments require an authenticated session; admin routes
// additionally require the `admin` role.
app.use(requestLog);
app.use("/orders", authenticate);
app.use("/payments", authenticate);
app.use("/refunds", authenticate);
app.use("/admin", authenticate, requireRole("admin"));

app.use(orders);
app.use(payments);
app.use(admin);

app.get("/health", (_req, res) => res.json({ status: "ok" }));

app.listen(config.port, () => {
  console.log(`checkout-service listening on :${config.port}`);
});
