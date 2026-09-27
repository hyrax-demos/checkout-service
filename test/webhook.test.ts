import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { computeSignature } from "../src/utils/webhookSignature";

vi.mock("../src/db", () => ({
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
    text: strings.join("?"),
    values,
  }),
  query: vi.fn(),
  withTransaction: vi.fn(),
}));

import { query } from "../src/db";
import { processedEvents } from "../src/processedEvents";
import { buildApp } from "./helpers/app";

const mockedQuery = query as unknown as ReturnType<typeof vi.fn>;

const TEST_SECRET = process.env.WEBHOOK_SECRET as string;
const ENDPOINT = "/webhooks/processor";

// Sign a payload with the same HMAC production uses, so tests never
// hard-code signatures.
function signPayload(body: string, secret: string = TEST_SECRET): string {
  return computeSignature(body, secret);
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

// Build a signed webhook request for `event`. `timestamp` defaults to now;
// `signature` overrides the computed one (pass null to omit the header).
function sendEvent(
  app: ReturnType<typeof buildApp>,
  event: unknown,
  opts: { timestamp?: number | string; signature?: string | null } = {}
) {
  const body = typeof event === "string" ? event : JSON.stringify(event);
  let req = request(app)
    .post(ENDPOINT)
    .set("Content-Type", "application/json")
    .set("x-webhook-timestamp", String(opts.timestamp ?? nowSec()));
  const signature = opts.signature === undefined ? signPayload(body) : opts.signature;
  if (signature !== null) req = req.set("x-webhook-signature", signature);
  return req.send(body);
}

const chargeSucceeded = {
  id: "evt_1",
  type: "charge.succeeded",
  data: { orderId: "order-1" },
};

describe("processor webhook", () => {
  const app = buildApp();

  // Minimal stand-in for the orders table so tests can assert on status.
  let orderStatus: Map<string, string>;

  beforeEach(async () => {
    orderStatus = new Map([["order-1", "pending"]]);
    mockedQuery.mockReset();
    mockedQuery.mockImplementation(async (q: { text: string; values: unknown[] }) => {
      const id = q.values[0] as string;
      if (q.text.startsWith("UPDATE orders SET status = 'paid'")) {
        if (q.text.includes("status = 'pending'") && orderStatus.get(id) !== "pending") {
          return [];
        }
        if (!orderStatus.has(id)) return [];
        orderStatus.set(id, "paid");
        return [{ id }];
      }
      if (q.text.startsWith("SELECT status FROM orders")) {
        return orderStatus.has(id) ? [{ status: orderStatus.get(id) }] : [];
      }
      return [];
    });
    await processedEvents.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("accepts a correctly signed, fresh charge.succeeded event", async () => {
    const res = await sendEvent(app, chargeSucceeded);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });
    expect(mockedQuery).toHaveBeenCalledTimes(1);
    const [statement] = mockedQuery.mock.calls[0];
    expect(statement.text).toContain("status = 'paid'");
    expect(statement.values).toEqual(["order-1"]);
    expect(orderStatus.get("order-1")).toBe("paid");
  });

  it("rejects paying an order that is not pending with 409 and leaves it unchanged", async () => {
    orderStatus.set("order-1", "cancelled");
    const res = await sendEvent(app, chargeSucceeded);
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "order is not awaiting payment" });
    expect(orderStatus.get("order-1")).toBe("cancelled");
    // The event is not recorded as processed.
    expect(await processedEvents.has(chargeSucceeded.id)).toBe(false);
  });

  it("rejects a second payment for an already paid order with 409", async () => {
    orderStatus.set("order-1", "paid");
    const res = await sendEvent(app, { ...chargeSucceeded, id: "evt_2" });
    expect(res.status).toBe(409);
    expect(orderStatus.get("order-1")).toBe("paid");
    expect(await processedEvents.has("evt_2")).toBe(false);
  });

  it("acknowledges a payment event for an unknown order without changes", async () => {
    const res = await sendEvent(app, { ...chargeSucceeded, data: { orderId: "missing" } });
    expect(res.status).toBe(200);
    expect(orderStatus.has("missing")).toBe(false);
  });

  it("accepts a sha256= prefixed signature", async () => {
    const body = JSON.stringify(chargeSucceeded);
    const res = await sendEvent(app, body, { signature: `sha256=${signPayload(body)}` });
    expect(res.status).toBe(200);
  });

  it("rejects a request with no signature with 401", async () => {
    const res = await sendEvent(app, chargeSucceeded, { signature: null });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "invalid signature" });
    expect(mockedQuery).not.toHaveBeenCalled();
  });

  it("rejects a request with a wrong signature with 401", async () => {
    const res = await sendEvent(app, chargeSucceeded, { signature: "0".repeat(64) });
    expect(res.status).toBe(401);
    expect(mockedQuery).not.toHaveBeenCalled();
  });

  it("rejects a signature of a different length with 401 (not 500)", async () => {
    const short = await sendEvent(app, chargeSucceeded, { signature: "abcd" });
    expect(short.status).toBe(401);
    const long = await sendEvent(app, chargeSucceeded, { signature: "a".repeat(128) });
    expect(long.status).toBe(401);
    const notHex = await sendEvent(app, chargeSucceeded, { signature: "z".repeat(64) });
    expect(notHex.status).toBe(401);
    expect(mockedQuery).not.toHaveBeenCalled();
  });

  it("rejects a body tampered with after signing with 401", async () => {
    const signed = JSON.stringify(chargeSucceeded);
    const tampered = JSON.stringify({ ...chargeSucceeded, data: { orderId: "order-2" } });
    const res = await sendEvent(app, tampered, { signature: signPayload(signed) });
    expect(res.status).toBe(401);
    expect(mockedQuery).not.toHaveBeenCalled();
    expect(orderStatus.get("order-1")).toBe("pending");
  });

  it("rejects a body signed with a different secret with 401", async () => {
    const body = JSON.stringify(chargeSucceeded);
    const res = await sendEvent(app, body, { signature: signPayload(body, "other-secret") });
    expect(res.status).toBe(401);
    expect(mockedQuery).not.toHaveBeenCalled();
  });

  it("checks the signature before the timestamp", async () => {
    const res = await sendEvent(app, chargeSucceeded, {
      signature: "0".repeat(64),
      timestamp: nowSec() - 3600,
    });
    expect(res.status).toBe(401);
  });

  it("rejects a timestamp older than 5 minutes with 400", async () => {
    const res = await sendEvent(app, chargeSucceeded, { timestamp: nowSec() - 301 });
    expect(res.status).toBe(400);
    expect(mockedQuery).not.toHaveBeenCalled();
  });

  it("uses the current clock for the 5-minute window (fake timers)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));
    const signedAt = nowSec();

    vi.setSystemTime(new Date("2024-01-01T00:05:00Z"));
    const atLimit = await sendEvent(app, chargeSucceeded, { timestamp: signedAt });
    expect(atLimit.status).toBe(200);

    vi.setSystemTime(new Date("2024-01-01T00:05:01Z"));
    const stale = await sendEvent(app, { ...chargeSucceeded, id: "evt_3" }, { timestamp: signedAt });
    expect(stale.status).toBe(400);
  });

  it("rejects a timestamp more than 5 minutes in the future with 400", async () => {
    const res = await sendEvent(app, chargeSucceeded, { timestamp: nowSec() + 301 });
    expect(res.status).toBe(400);
    expect(mockedQuery).not.toHaveBeenCalled();
  });

  it("rejects a missing or non-numeric timestamp with 400", async () => {
    const body = JSON.stringify(chargeSucceeded);
    const missing = await request(app)
      .post(ENDPOINT)
      .set("Content-Type", "application/json")
      .set("x-webhook-signature", signPayload(body))
      .send(body);
    expect(missing.status).toBe(400);

    const garbage = await sendEvent(app, body, { timestamp: "yesterday" });
    expect(garbage.status).toBe(400);
    expect(mockedQuery).not.toHaveBeenCalled();
  });

  it("rejects a signed but malformed JSON body with 400", async () => {
    const res = await sendEvent(app, "{not json");
    expect(res.status).toBe(400);
    expect(mockedQuery).not.toHaveBeenCalled();
  });

  it("acknowledges a replayed event without re-processing it", async () => {
    const first = await sendEvent(app, chargeSucceeded);
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ received: true });
    expect(mockedQuery).toHaveBeenCalledTimes(1);

    const replay = await sendEvent(app, chargeSucceeded);
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual({ received: true, duplicate: true });
    // The order update ran exactly once across both deliveries.
    expect(mockedQuery).toHaveBeenCalledTimes(1);
  });

  it("rejects a signed event with no id with 400", async () => {
    const res = await sendEvent(app, { type: "charge.succeeded", data: { orderId: "order-1" } });
    expect(res.status).toBe(400);
    expect(mockedQuery).not.toHaveBeenCalled();
  });
});
