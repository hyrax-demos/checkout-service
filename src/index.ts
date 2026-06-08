import express from "express";
import { config } from "./config";
import { orders } from "./routes/orders";
import { payments } from "./routes/payments";
import { admin } from "./routes/admin";

const app = express();
app.use(express.json());

app.use(orders);
app.use(payments);
app.use(admin);

app.get("/health", (_req, res) => res.json({ status: "ok" }));

app.listen(config.port, () => {
  console.log(`checkout-service listening on :${config.port}`);
});
