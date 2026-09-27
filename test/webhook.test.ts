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
import { signatureValid } from "../src/routes/webhook";

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
});

describe("processor webhook signature header", () => {
  const app = buildApp();

  // A forged goodwill credit: if this is ever applied, an attacker can credit
  // any account.
  const forgedCredit = JSON.stringify({
    id: "evt_forged",
    type: "credit.issued",
    data: { customerId: "cust-1", amount: 10000 },
  });

  beforeEach(() => {
    mockedQuery.mockReset();
    mockedQuery.mockResolvedValue([]);
  });

  it("rejects a forged credit.issued with no signature header and writes nothing", async () => {
    const res = await request(app)
      .post("/webhooks/processor")
      .set("Content-Type", "application/json")
      .send(forgedCredit);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "missing signature" });
    expect(mockedQuery).not.toHaveBeenCalled();
  });

  it("rejects an empty signature header and writes nothing", async () => {
    const res = await request(app)
      .post("/webhooks/processor")
      .set("Content-Type", "application/json")
      .set("x-processor-signature", "")
      .send(forgedCredit);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "missing signature" });
    expect(mockedQuery).not.toHaveBeenCalled();
  });

  it("rejects a whitespace-only signature header and writes nothing", async () => {
    const res = await request(app)
      .post("/webhooks/processor")
      .set("Content-Type", "application/json")
      .set("x-processor-signature", "   ")
      .send(forgedCredit);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "missing signature" });
    expect(mockedQuery).not.toHaveBeenCalled();
  });

  it("rejects a repeated signature header and writes nothing", async () => {
    const res = await request(app)
      .post("/webhooks/processor")
      .set("Content-Type", "application/json")
      .set("x-processor-signature", [sign(forgedCredit), sign(forgedCredit)])
      .send(forgedCredit);
    expect(res.status).toBe(400);
    expect(mockedQuery).not.toHaveBeenCalled();
  });

  it("rejects a credit.issued with a wrong signature and writes nothing", async () => {
    const res = await request(app)
      .post("/webhooks/processor")
      .set("Content-Type", "application/json")
      .set("x-processor-signature", "0".repeat(64))
      .send(forgedCredit);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "invalid signature" });
    expect(mockedQuery).not.toHaveBeenCalled();
  });

  it("applies a correctly signed credit.issued event", async () => {
    const res = await request(app)
      .post("/webhooks/processor")
      .set("Content-Type", "application/json")
      .set("x-processor-signature", sign(forgedCredit))
      .send(forgedCredit);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });
    expect(mockedQuery).toHaveBeenCalledTimes(1);
    const q = mockedQuery.mock.calls[0][0];
    expect(q.text).toContain("INSERT INTO account_credits");
    expect(q.values).toEqual(["cust-1", 10000]);
  });
});

describe("processor webhook signature format", () => {
  const app = buildApp();

  const credit = JSON.stringify({
    id: "evt_credit",
    type: "credit.issued",
    data: { customerId: "cust-1", amount: 10000 },
  });

  beforeEach(() => {
    mockedQuery.mockReset();
    mockedQuery.mockResolvedValue([]);
  });

  async function postWithSignature(signature: string) {
    return request(app)
      .post("/webhooks/processor")
      .set("Content-Type", "application/json")
      .set("x-processor-signature", signature)
      .send(credit);
  }

  it("rejects a signature one hex char too short and writes nothing", async () => {
    const res = await postWithSignature(sign(credit).slice(0, -1));
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "invalid signature" });
    expect(mockedQuery).not.toHaveBeenCalled();
  });

  it("rejects a signature one hex char too long and writes nothing", async () => {
    // Buffer.from(hex) would silently drop the trailing nibble; this must not
    // be accepted as the correct signature.
    const res = await postWithSignature(sign(credit) + "0");
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "invalid signature" });
    expect(mockedQuery).not.toHaveBeenCalled();
  });

  it("rejects a correct-length signature with a non-hex character and writes nothing", async () => {
    const res = await postWithSignature("z" + sign(credit).slice(1));
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "invalid signature" });
    expect(mockedQuery).not.toHaveBeenCalled();
  });

  it("rejects a correct-length, valid-hex but wrong signature and writes nothing", async () => {
    const good = sign(credit);
    const flipped = (good[0] === "a" ? "b" : "a") + good.slice(1);
    const res = await postWithSignature(flipped);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "invalid signature" });
    expect(mockedQuery).not.toHaveBeenCalled();
  });

  it("keeps accepting a correct signature in uppercase hex (unchanged behaviour)", async () => {
    const res = await postWithSignature(sign(credit).toUpperCase());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });
    expect(mockedQuery).toHaveBeenCalledTimes(1);
  });

  it("still applies a correctly signed credit.issued exactly as before", async () => {
    const res = await postWithSignature(sign(credit));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });
    expect(mockedQuery).toHaveBeenCalledTimes(1);
    const q = mockedQuery.mock.calls[0][0];
    expect(q.text).toContain("INSERT INTO account_credits");
    expect(q.values).toEqual(["cust-1", 10000]);
  });
});

describe("signatureValid", () => {
  const body = Buffer.from('{"id":"evt_1","type":"charge.succeeded","data":{}}');
  const good = sign(body.toString("utf8"));

  it("accepts the correct signature", () => {
    expect(signatureValid(body, good)).toBe(true);
  });

  it.each([
    ["empty", ""],
    ["too short", good.slice(0, -1)],
    ["too long", good + "0"],
    ["double length", good + good],
    ["non-hex char", "z" + good.slice(1)],
    ["whitespace", " " + good.slice(1)],
    ["non-ascii", "\u00e9" + good.slice(1)],
    ["prefixed", "sha256=" + good],
  ])("returns false without throwing for a %s signature", (_label, sig) => {
    expect(() => signatureValid(body, sig)).not.toThrow();
    expect(signatureValid(body, sig)).toBe(false);
  });

  it("returns false without throwing for non-string / non-Buffer inputs", () => {
    expect(signatureValid(body, undefined as unknown as string)).toBe(false);
    expect(signatureValid({} as unknown as Buffer, good)).toBe(false);
  });
});
