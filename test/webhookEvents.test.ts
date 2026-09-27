import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { computeSignature } from "../src/utils/webhookSignature";
import { testToken } from "./helpers/token";

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
import { InMemoryWebhookEventLog, webhookEventLog } from "../src/webhookEventLog";
import { buildApp } from "./helpers/app";

const mockedQuery = query as unknown as ReturnType<typeof vi.fn>;
const TEST_SECRET = process.env.WEBHOOK_SECRET as string;

// Sign with the same HMAC production uses, so tests never hard-code signatures.
function signPayload(body: string, secret: string = TEST_SECRET): string {
  return computeSignature(body, secret);
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function sendEvent(
  app: ReturnType<typeof buildApp>,
  event: unknown,
  opts: { timestamp?: number; signature?: string } = {}
) {
  const body = JSON.stringify(event);
  return request(app)
    .post("/webhooks/processor")
    .set("Content-Type", "application/json")
    .set("x-webhook-timestamp", String(opts.timestamp ?? nowSec()))
    .set("x-webhook-signature", opts.signature ?? signPayload(body))
    .send(body);
}

function charge(id: string, orderId = "order-1") {
  return { id, type: "charge.succeeded", data: { orderId } };
}

describe("GET /admin/webhook-events", () => {
  const app = buildApp();
  const adminToken = testToken("admin-1", "admin");
  const customerToken = testToken("user-1");
  let orderStatus: Map<string, string>;

  const listEvents = (qs = "", token = adminToken) =>
    request(app).get(`/admin/webhook-events${qs}`).set("Authorization", `Bearer ${token}`);

  beforeEach(async () => {
    orderStatus = new Map([
      ["order-1", "pending"],
      ["order-2", "cancelled"],
    ]);
    mockedQuery.mockReset();
    mockedQuery.mockImplementation(async (q: { text: string; values: unknown[] }) => {
      const id = q.values[0] as string;
      if (q.text.startsWith("UPDATE orders SET status = 'paid'")) {
        if (orderStatus.get(id) !== "pending") return [];
        orderStatus.set(id, "paid");
        return [{ id }];
      }
      if (q.text.startsWith("SELECT status FROM orders")) {
        return orderStatus.has(id) ? [{ status: orderStatus.get(id) }] : [];
      }
      return [];
    });
    await processedEvents.clear();
    await webhookEventLog.clear();
  });

  it("requires authentication", async () => {
    const res = await request(app).get("/admin/webhook-events");
    expect(res.status).toBe(401);
  });

  it("rejects a non-admin caller", async () => {
    const res = await listEvents("", customerToken);
    expect(res.status).toBe(403);
  });

  it("returns an empty list when nothing has been received", async () => {
    const res = await listEvents();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ events: [], total: 0, limit: 50, offset: 0 });
  });

  it("records processed, duplicate and rejected deliveries newest first", async () => {
    expect((await sendEvent(app, charge("evt_1"))).status).toBe(200);
    expect((await sendEvent(app, charge("evt_1"))).status).toBe(200);
    expect((await sendEvent(app, charge("evt_2", "order-2"))).status).toBe(409);
    expect(
      (await sendEvent(app, charge("evt_forged"), { signature: "0".repeat(64) })).status
    ).toBe(401);
    expect(
      (await sendEvent(app, charge("evt_3"), { timestamp: nowSec() - 3600 })).status
    ).toBe(400);

    const res = await listEvents();
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(5);
    const summary = res.body.events.map((e: any) => [
      e.event_id,
      e.type,
      e.order_id,
      e.outcome,
      e.reason,
      e.status,
    ]);
    expect(summary).toEqual([
      ["evt_3", "charge.succeeded", "order-1", "rejected", "stale_timestamp", 400],
      // Unsigned payloads are never trusted, so their fields are not logged.
      [null, null, null, "rejected", "invalid_signature", 401],
      ["evt_2", "charge.succeeded", "order-2", "rejected", "invalid_transition", 409],
      ["evt_1", "charge.succeeded", "order-1", "duplicate", "already_processed", 200],
      ["evt_1", "charge.succeeded", "order-1", "processed", null, 200],
    ]);
    for (const e of res.body.events) {
      expect(new Date(e.received_at).toISOString()).toBe(e.received_at);
    }
  });

  it("paginates with limit and offset", async () => {
    for (let i = 1; i <= 5; i++) {
      orderStatus.set(`order-${i}0`, "pending");
      await sendEvent(app, charge(`evt_${i}`, `order-${i}0`));
    }

    const first = await listEvents("?limit=2");
    expect(first.body.events.map((e: any) => e.event_id)).toEqual(["evt_5", "evt_4"]);
    expect(first.body).toMatchObject({ total: 5, limit: 2, offset: 0 });

    const second = await listEvents("?limit=2&offset=2");
    expect(second.body.events.map((e: any) => e.event_id)).toEqual(["evt_3", "evt_2"]);

    const last = await listEvents("?limit=2&offset=4");
    expect(last.body.events.map((e: any) => e.event_id)).toEqual(["evt_1"]);

    const past = await listEvents("?offset=10");
    expect(past.body.events).toEqual([]);
    expect(past.body.total).toBe(5);
  });

  it("rejects invalid pagination parameters with 400", async () => {
    for (const qs of ["?limit=0", "?limit=201", "?limit=abc", "?offset=-1", "?offset=1.5"]) {
      const res = await listEvents(qs);
      expect(res.status, qs).toBe(400);
    }
  });

  it("does not change webhook responses", async () => {
    const res = await sendEvent(app, charge("evt_1"));
    expect(res.body).toEqual({ received: true });
    expect(orderStatus.get("order-1")).toBe("paid");
  });
});

describe("InMemoryWebhookEventLog", () => {
  it("drops the oldest entries once it reaches its cap", async () => {
    const log = new InMemoryWebhookEventLog(2);
    for (const id of ["a", "b", "c"]) {
      await log.record({
        event_id: id,
        type: "charge.succeeded",
        order_id: null,
        outcome: "processed",
        reason: null,
        status: 200,
        received_at: new Date().toISOString(),
      });
    }
    const page = await log.list({ limit: 10, offset: 0 });
    expect(page.total).toBe(2);
    expect(page.events.map((e) => e.event_id)).toEqual(["c", "b"]);
  });
});
