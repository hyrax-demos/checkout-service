import { describe, it, expect, vi, beforeEach } from "vitest";
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

  beforeEach(() => {
    mockedQuery.mockReset();
    mockedQuery.mockResolvedValue([]);
  });

  it("accepts a correctly signed, fresh charge.succeeded event", async () => {
    const res = await sendEvent(app, chargeSucceeded);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });
    expect(mockedQuery).toHaveBeenCalledTimes(1);
    const [statement] = mockedQuery.mock.calls[0];
    expect(statement.text).toContain("status = 'paid'");
    expect(statement.values).toEqual(["order-1"]);
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
});
