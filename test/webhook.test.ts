import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { createHmac } from "crypto";

vi.mock("../src/db", () => ({
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
    text: strings.join("?"),
    values,
  }),
  query: vi.fn(),
  withTransaction: vi.fn(),
}));

import { query } from "../src/db";
import { buildApp } from "./helpers/app";

const mockedQuery = query as unknown as ReturnType<typeof vi.fn>;

function sign(body: string): string {
  return createHmac("sha256", process.env.WEBHOOK_SECRET as string)
    .update(body)
    .digest("hex");
}

describe("processor webhook", () => {
  const app = buildApp();

  beforeEach(() => {
    mockedQuery.mockReset();
    mockedQuery.mockResolvedValue([]);
  });

  it("rejects a request with no signature", async () => {
    const body = JSON.stringify({ id: "evt_1", type: "charge.succeeded", data: {} });
    const res = await request(app)
      .post("/webhooks/processor")
      .set("Content-Type", "application/json")
      .send(body);
    expect(res.status).toBe(400);
  });

  it("rejects a request with a wrong signature", async () => {
    const body = JSON.stringify({ id: "evt_1", type: "charge.succeeded", data: {} });
    const res = await request(app)
      .post("/webhooks/processor")
      .set("Content-Type", "application/json")
      .set("x-processor-signature", "0".repeat(64))
      .send(body);
    expect(res.status).toBe(400);
  });

  it("accepts a correctly signed charge.succeeded event", async () => {
    const body = JSON.stringify({
      id: "evt_1",
      type: "charge.succeeded",
      data: { orderId: "order-1" },
    });
    const res = await request(app)
      .post("/webhooks/processor")
      .set("Content-Type", "application/json")
      .set("x-processor-signature", sign(body))
      .send(body);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });
  });

  const creditBody = JSON.stringify({
    id: "evt_2",
    type: "credit.issued",
    data: { customerId: "cust-1", amount: 500 },
  });

  it("rejects a forged credit.issued with no signature header and writes nothing", async () => {
    const res = await request(app)
      .post("/webhooks/processor")
      .set("Content-Type", "application/json")
      .send(creditBody);
    expect(res.status).toBe(400);
    expect(mockedQuery).not.toHaveBeenCalled();
  });

  it("rejects a forged credit.issued with an empty signature header and writes nothing", async () => {
    const res = await request(app)
      .post("/webhooks/processor")
      .set("Content-Type", "application/json")
      .set("x-processor-signature", "")
      .send(creditBody);
    expect(res.status).toBe(400);
    expect(mockedQuery).not.toHaveBeenCalled();
  });

  it("rejects a forged credit.issued with a whitespace-only signature header and writes nothing", async () => {
    const res = await request(app)
      .post("/webhooks/processor")
      .set("Content-Type", "application/json")
      .set("x-processor-signature", "   ")
      .send(creditBody);
    expect(res.status).toBe(400);
    expect(mockedQuery).not.toHaveBeenCalled();
  });

  it("applies a correctly signed credit.issued event", async () => {
    const res = await request(app)
      .post("/webhooks/processor")
      .set("Content-Type", "application/json")
      .set("x-processor-signature", sign(creditBody))
      .send(creditBody);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });
    expect(mockedQuery).toHaveBeenCalledTimes(1);
    const [stmt] = mockedQuery.mock.calls[0];
    expect(stmt.text).toContain("INSERT INTO account_credits");
    expect(stmt.values).toEqual(["cust-1", 500]);
  });
});
