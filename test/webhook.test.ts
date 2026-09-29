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

  it("rejects a credit.issued event with no signature header and writes no credit", async () => {
    const body = JSON.stringify({
      id: "evt_2",
      type: "credit.issued",
      data: { customerId: "cust-1", amount: 5000 },
    });
    const res = await request(app)
      .post("/webhooks/processor")
      .set("Content-Type", "application/json")
      .send(body);
    expect(res.status).toBe(400);
    expect(mockedQuery).not.toHaveBeenCalled();
  });

  it("rejects a credit.issued event with an empty signature header and writes no credit", async () => {
    const body = JSON.stringify({
      id: "evt_3",
      type: "credit.issued",
      data: { customerId: "cust-1", amount: 5000 },
    });
    const res = await request(app)
      .post("/webhooks/processor")
      .set("Content-Type", "application/json")
      .set("x-processor-signature", "")
      .send(body);
    expect(res.status).toBe(400);
    expect(mockedQuery).not.toHaveBeenCalled();
  });

  it("rejects a credit.issued event with a whitespace-only signature header and writes no credit", async () => {
    const body = JSON.stringify({
      id: "evt_4",
      type: "credit.issued",
      data: { customerId: "cust-1", amount: 5000 },
    });
    const res = await request(app)
      .post("/webhooks/processor")
      .set("Content-Type", "application/json")
      .set("x-processor-signature", "   ")
      .send(body);
    expect(res.status).toBe(400);
    expect(mockedQuery).not.toHaveBeenCalled();
  });

  it("applies a correctly signed credit.issued event to the credits ledger", async () => {
    const body = JSON.stringify({
      id: "evt_5",
      type: "credit.issued",
      data: { customerId: "cust-1", amount: 5000 },
    });
    const res = await request(app)
      .post("/webhooks/processor")
      .set("Content-Type", "application/json")
      .set("x-processor-signature", sign(body))
      .send(body);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });
    expect(mockedQuery).toHaveBeenCalledTimes(1);
    const [stmt] = mockedQuery.mock.calls[0];
    expect(stmt.text).toContain("INSERT INTO account_credits");
    expect(stmt.values).toEqual(["cust-1", 5000]);
  });

  const creditBody = () =>
    JSON.stringify({
      id: "evt_6",
      type: "credit.issued",
      data: { customerId: "cust-1", amount: 5000 },
    });

  it("rejects a too-short signature with 400 and writes no credit", async () => {
    const body = creditBody();
    const res = await request(app)
      .post("/webhooks/processor")
      .set("Content-Type", "application/json")
      .set("x-processor-signature", sign(body).slice(0, 32))
      .send(body);
    expect(res.status).toBe(400);
    expect(mockedQuery).not.toHaveBeenCalled();
  });

  it("rejects a too-long signature (valid digest plus extra hex) with 400", async () => {
    const body = creditBody();
    const res = await request(app)
      .post("/webhooks/processor")
      .set("Content-Type", "application/json")
      .set("x-processor-signature", sign(body) + "00")
      .send(body);
    expect(res.status).toBe(400);
    expect(mockedQuery).not.toHaveBeenCalled();
  });

  it("rejects an odd-length signature with 400", async () => {
    const body = creditBody();
    const res = await request(app)
      .post("/webhooks/processor")
      .set("Content-Type", "application/json")
      .set("x-processor-signature", sign(body).slice(0, 63))
      .send(body);
    expect(res.status).toBe(400);
    expect(mockedQuery).not.toHaveBeenCalled();
  });

  it("rejects a correct-length signature containing non-hex characters with 400", async () => {
    const body = creditBody();
    const res = await request(app)
      .post("/webhooks/processor")
      .set("Content-Type", "application/json")
      .set("x-processor-signature", "z".repeat(64))
      .send(body);
    expect(res.status).toBe(400);
    expect(mockedQuery).not.toHaveBeenCalled();
  });

  it("rejects a valid digest with trailing non-hex characters with 400", async () => {
    const body = creditBody();
    const res = await request(app)
      .post("/webhooks/processor")
      .set("Content-Type", "application/json")
      .set("x-processor-signature", sign(body) + "zz")
      .send(body);
    expect(res.status).toBe(400);
    expect(mockedQuery).not.toHaveBeenCalled();
  });

  it("rejects a correct-length hex signature that does not match with 400", async () => {
    const body = creditBody();
    const good = sign(body);
    const flipped = (good[0] === "a" ? "b" : "a") + good.slice(1);
    const res = await request(app)
      .post("/webhooks/processor")
      .set("Content-Type", "application/json")
      .set("x-processor-signature", flipped)
      .send(body);
    expect(res.status).toBe(400);
    expect(mockedQuery).not.toHaveBeenCalled();
  });

  it("accepts a valid signature sent in upper-case hex", async () => {
    const body = creditBody();
    const res = await request(app)
      .post("/webhooks/processor")
      .set("Content-Type", "application/json")
      .set("x-processor-signature", sign(body).toUpperCase())
      .send(body);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });
    expect(mockedQuery).toHaveBeenCalledTimes(1);
  });

  it("rejects a signed request whose body is not raw JSON with 400, not 5xx", async () => {
    const body = creditBody();
    const res = await request(app)
      .post("/webhooks/processor")
      .set("Content-Type", "text/plain")
      .set("x-processor-signature", sign(body))
      .send(body);
    expect(res.status).toBe(400);
    expect(mockedQuery).not.toHaveBeenCalled();
  });
});
