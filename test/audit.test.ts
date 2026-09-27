import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { testToken } from "./helpers/token";

// Unlike the other route tests, this file mocks `pg` rather than `../src/db`,
// so the real `sql` tag, `query` and `withTransaction` run. That lets the
// tests check which statements land inside a transaction and that a failed
// audit write rolls the whole transaction back.
type Handler = (text: string, values: unknown[]) => unknown[] | Promise<unknown[]>;

const pgState = vi.hoisted(() => ({
  // Every statement issued, in order, tagged with where it ran.
  statements: [] as { via: "pool" | "client"; text: string; values: unknown[] }[],
  handler: (() => []) as Handler,
}));

vi.mock("pg", () => {
  async function run(via: "pool" | "client", text: string, values: unknown[] = []) {
    pgState.statements.push({ via, text, values });
    if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") {
      return { rows: [] };
    }
    return { rows: await pgState.handler(text, values) };
  }
  class Pool {
    query(text: string, values?: unknown[]) {
      return run("pool", text, values);
    }
    async connect() {
      return {
        query: (text: string, values?: unknown[]) => run("client", text, values),
        release: () => {},
      };
    }
  }
  return { Pool };
});

import { buildApp } from "./helpers/app";
import * as processor from "../src/processor";

function auditInserts() {
  return pgState.statements.filter((s) => s.text.includes("INSERT INTO audit_events"));
}

function statementTexts() {
  return pgState.statements.map((s) => s.text);
}

describe("audit log", () => {
  const app = buildApp();
  const customerToken = testToken("user-1");
  const adminToken = testToken("admin-1", "admin");

  beforeEach(() => {
    pgState.statements = [];
    pgState.handler = () => [];
  });

  describe("recording", () => {
    it("records an order.charged event in the same statement that marks the order paid", async () => {
      pgState.handler = (text) =>
        text.startsWith("SELECT id, total, status FROM orders")
          ? [{ id: "order-1", total: 1999, status: "pending" }]
          : [];

      const res = await request(app)
        .post("/payments/charge")
        .set("Authorization", `Bearer ${customerToken}`)
        .send({ orderId: "order-1" });

      expect(res.status).toBe(200);
      const inserts = auditInserts();
      expect(inserts).toHaveLength(1);
      // The status change and the audit insert are one atomic statement.
      expect(inserts[0].text).toContain("UPDATE orders SET status = 'paid'");
      expect(inserts[0].text).toContain("'order.charged'");
      expect(inserts[0].values).toContain("order-1");
    });

    it("records a refund.issued event inside the refund transaction", async () => {
      pgState.handler = (text) =>
        text.startsWith("SELECT id, total, status FROM orders")
          ? [{ id: "order-1", total: 1999, status: "paid" }]
          : [];

      const res = await request(app)
        .post("/refunds")
        .set("Authorization", `Bearer ${customerToken}`)
        .send({ reference: "ord_abc", amountDollars: 5 });

      expect(res.status).toBe(200);
      const inserts = auditInserts();
      expect(inserts).toHaveLength(1);
      expect(inserts[0].via).toBe("client");
      expect(inserts[0].text).toContain("'refund.issued'");
      expect(inserts[0].values).toContain(500);
      expect(inserts[0].values).toContain("order-1");

      const texts = statementTexts();
      const begin = texts.indexOf("BEGIN");
      const commit = texts.indexOf("COMMIT");
      const insertAt = texts.indexOf(inserts[0].text);
      expect(begin).toBeGreaterThanOrEqual(0);
      expect(begin).toBeLessThan(insertAt);
      expect(insertAt).toBeLessThan(commit);
    });

    it("records a capture_batch.captured event atomically with each claim", async () => {
      pgState.handler = (text, values) => {
        if (text.startsWith("SELECT id, total, status FROM orders")) {
          return [
            { id: "order-1", total: 500, status: "pending" },
            { id: "order-2", total: 700, status: "paid" },
          ];
        }
        if (text.includes("'capture_batch.captured'")) {
          return [{ id: values[0] }];
        }
        return [];
      };

      const res = await request(app)
        .post("/payments/capture-batch")
        .set("Authorization", `Bearer ${customerToken}`)
        .send({ orderIds: ["order-1", "order-2"] });

      expect(res.status).toBe(200);
      expect(res.body.captured).toEqual(["order-1"]);
      const inserts = auditInserts();
      // Only the pending order is claimed and audited. The skipped one is not.
      expect(inserts).toHaveLength(1);
      expect(inserts[0].text).toContain("status = 'pending'");
      expect(inserts[0].text).toContain("'capture_batch.captured'");
      expect(inserts[0].values).toContain("order-1");
    });

    it("records a compensating capture_batch.released event when the capture fails", async () => {
      pgState.handler = (text, values) => {
        if (text.startsWith("SELECT id, total, status FROM orders")) {
          return [{ id: "order-1", total: 500, status: "pending" }];
        }
        if (text.includes("'capture_batch.captured'")) {
          return [{ id: values[0] }];
        }
        return [];
      };
      const chargeSpy = vi
        .spyOn(processor, "chargeProcessor")
        .mockRejectedValueOnce(new processor.ProcessorError("declined"));

      const res = await request(app)
        .post("/payments/capture-batch")
        .set("Authorization", `Bearer ${customerToken}`)
        .send({ orderIds: ["order-1"] });

      expect(res.status).toBe(200);
      expect(res.body.captured).toEqual([]);
      const actions = auditInserts().map((s) =>
        s.text.includes("'capture_batch.released'") ? "released" : "captured"
      );
      expect(actions).toEqual(["captured", "released"]);
      const released = auditInserts()[1];
      expect(released.text).toContain("SET status = 'pending'");
      chargeSpy.mockRestore();
    });
  });

  describe("transactional rollback", () => {
    it("rolls back the refund when the audit insert fails", async () => {
      pgState.handler = (text) => {
        if (text.startsWith("SELECT id, total, status FROM orders")) {
          return [{ id: "order-1", total: 1999, status: "paid" }];
        }
        if (text.includes("INSERT INTO audit_events")) {
          throw new Error("audit_events unavailable");
        }
        return [];
      };

      const res = await request(app)
        .post("/refunds")
        .set("Authorization", `Bearer ${customerToken}`)
        .send({ reference: "ord_abc", amountDollars: 5 });

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: "refund failed" });
      const texts = statementTexts();
      expect(texts).toContain("ROLLBACK");
      expect(texts).not.toContain("COMMIT");
      // The refund row and the status change ran on the same transaction client
      // as the failed audit write, so the ROLLBACK undoes them.
      const clientWrites = pgState.statements
        .filter((s) => s.via === "client")
        .map((s) => s.text);
      expect(clientWrites.some((t) => t.includes("INSERT INTO refunds"))).toBe(true);
      expect(clientWrites.some((t) => t.includes("SET status = 'refunded'"))).toBe(true);
    });
  });

  describe("GET /admin/audit", () => {
    it("requires authentication", async () => {
      const res = await request(app).get("/admin/audit");
      expect(res.status).toBe(401);
      expect(pgState.statements).toHaveLength(0);
    });

    it("rejects a non-admin caller", async () => {
      const res = await request(app)
        .get("/admin/audit")
        .set("Authorization", `Bearer ${customerToken}`);
      expect(res.status).toBe(403);
      expect(pgState.statements).toHaveLength(0);
    });

    it("lists events newest first with default pagination", async () => {
      const events = [
        {
          id: "e2",
          customerId: "user-1",
          action: "refund.issued",
          orderId: "order-1",
          amountCents: "500",
          createdAt: "2026-09-27T02:00:00.000Z",
        },
        {
          id: "e1",
          customerId: "user-1",
          action: "order.charged",
          orderId: "order-1",
          amountCents: "1999",
          createdAt: "2026-09-27T01:00:00.000Z",
        },
      ];
      pgState.handler = (text) => (text.includes("FROM audit_events") ? events : []);

      const res = await request(app)
        .get("/admin/audit")
        .set("Authorization", `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.limit).toBe(50);
      expect(res.body.offset).toBe(0);
      expect(res.body.events.map((e: { id: string }) => e.id)).toEqual(["e2", "e1"]);
      expect(res.body.events[0].amountCents).toBe(500);

      const [select] = pgState.statements;
      expect(select.text).toContain("ORDER BY created_at DESC");
      expect(select.values).toEqual([50, 0]);
    });

    it("passes limit and offset through as query parameters", async () => {
      const res = await request(app)
        .get("/admin/audit?limit=10&offset=20")
        .set("Authorization", `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ events: [], limit: 10, offset: 20 });
      expect(pgState.statements[0].values).toEqual([10, 20]);
    });

    it.each([
      ["zero limit", "limit=0"],
      ["negative limit", "limit=-1"],
      ["non-numeric limit", "limit=abc"],
      ["fractional limit", "limit=1.5"],
      ["limit above the cap", "limit=201"],
      ["negative offset", "offset=-1"],
      ["non-numeric offset", "offset=x"],
    ])("rejects a %s", async (_label, qs) => {
      const res = await request(app)
        .get(`/admin/audit?${qs}`)
        .set("Authorization", `Bearer ${adminToken}`);
      expect(res.status).toBe(400);
      expect(pgState.statements).toHaveLength(0);
    });
  });
});
