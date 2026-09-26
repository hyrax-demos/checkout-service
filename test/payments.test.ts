import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { testToken } from "./helpers/token";

vi.mock("../src/db", () => ({
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
    text: strings.join("?"),
    values,
  }),
  query: vi.fn(),
  withTransaction: vi.fn(),
}));

vi.mock("../src/processor", async (importActual) => {
  const actual = await importActual<typeof import("../src/processor")>();
  return {
    ...actual,
    chargeProcessor: vi.fn().mockResolvedValue(undefined),
    refundProcessor: vi.fn().mockResolvedValue(undefined),
  };
});

import { query, withTransaction } from "../src/db";
import { refundProcessor, ProcessorError } from "../src/processor";
import { buildApp } from "./helpers/app";

const mockedRefundProcessor = refundProcessor as unknown as ReturnType<
  typeof vi.fn
>;

const mockedQuery = query as unknown as ReturnType<typeof vi.fn>;
const mockedWithTransaction = withTransaction as unknown as ReturnType<
  typeof vi.fn
>;

// A fresh fake transaction client per call: records what was executed inside
// the transaction without asserting on it here (that belongs to the
// task-specific hidden oracles, not the baseline).
function fakeTransaction() {
  const client = { query: vi.fn().mockResolvedValue([]) };
  mockedWithTransaction.mockImplementationOnce(async (fn: any) => fn(client));
  return client;
}

describe("payments routes", () => {
  const app = buildApp();
  const token = testToken("user-1");

  beforeEach(() => {
    mockedQuery.mockReset();
    mockedWithTransaction.mockReset();
    mockedRefundProcessor.mockReset();
    mockedRefundProcessor.mockResolvedValue(undefined);
  });

  describe("POST /payments/charge", () => {
    it("returns 404 when the order does not belong to the caller", async () => {
      mockedQuery.mockResolvedValueOnce([]);
      const res = await request(app)
        .post("/payments/charge")
        .set("Authorization", `Bearer ${token}`)
        .send({ orderId: "order-1" });
      expect(res.status).toBe(404);
    });

    it("returns 409 when the order is not awaiting payment", async () => {
      mockedQuery.mockResolvedValueOnce([
        { id: "order-1", total: 1999, status: "paid" },
      ]);
      const res = await request(app)
        .post("/payments/charge")
        .set("Authorization", `Bearer ${token}`)
        .send({ orderId: "order-1" });
      expect(res.status).toBe(409);
    });

    it("captures payment for a pending order", async () => {
      mockedQuery.mockResolvedValueOnce([
        { id: "order-1", total: 1999, status: "pending" },
      ]);
      mockedQuery.mockResolvedValueOnce([]);
      const res = await request(app)
        .post("/payments/charge")
        .set("Authorization", `Bearer ${token}`)
        .send({ orderId: "order-1" });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
      // Two DB round-trips: look up the order, then flip it to paid. The
      // idempotency key's exact value is a task target, not a baseline.
      expect(mockedQuery).toHaveBeenCalledTimes(2);
    });
  });

  describe("POST /refunds", () => {
    it("rejects a non-positive amount", async () => {
      const res = await request(app)
        .post("/refunds")
        .set("Authorization", `Bearer ${token}`)
        .send({ reference: "ord_abc", amountDollars: 0 });
      expect(res.status).toBe(400);
    });

    it("returns 404 when no order has that reference", async () => {
      mockedQuery.mockResolvedValueOnce([]);
      const res = await request(app)
        .post("/refunds")
        .set("Authorization", `Bearer ${token}`)
        .send({ reference: "ord_missing", amountDollars: 5 });
      expect(res.status).toBe(404);
    });

    it("returns 409 for an order that cannot be refunded", async () => {
      mockedQuery.mockResolvedValueOnce([
        { id: "order-1", total: 1999, status: "pending" },
      ]);
      const res = await request(app)
        .post("/refunds")
        .set("Authorization", `Bearer ${token}`)
        .send({ reference: "ord_abc", amountDollars: 5 });
      expect(res.status).toBe(409);
    });

    it("refunds a paid order for its full amount", async () => {
      // Routed by SQL text rather than call order: a correct fix for M3 (see
      // bench task M3) adds a query for the order's prior refund total
      // between the order lookup and the transaction, which a positional
      // `mockResolvedValueOnce` sequence would misattribute. Anything this
      // fixture doesn't recognise defaults to "no rows", which for a
      // COALESCE(SUM(...), 0)-shaped lookup on a fresh order is correct.
      mockedQuery.mockImplementation(async (q: { text: string }) => {
        if (q.text.includes("FROM orders")) {
          return [{ id: "order-1", total: 1999, status: "paid" }];
        }
        return [];
      });
      fakeTransaction();
      const res = await request(app)
        .post("/refunds")
        .set("Authorization", `Bearer ${token}`)
        .send({ reference: "ord_abc", amountDollars: 19.99 });
      expect(res.status).toBe(200);
      expect(res.body.refunded).toBe(true);
      expect(res.body.amount).toBe(1999);
      expect(typeof res.body.refundId).toBe("string");
    });

    describe("refund correctness", () => {
      // Transaction client whose prior-refund SUM returns `alreadyRefunded`.
      function refundTransaction(alreadyRefunded: number, calls: string[]) {
        const client = {
          query: vi.fn(async (q: { text: string }) => {
            calls.push(`tx:${q.text}`);
            if (q.text.includes("SUM(amount)")) {
              return [{ refunded: alreadyRefunded }];
            }
            return [];
          }),
        };
        mockedWithTransaction.mockImplementationOnce(async (fn: any) =>
          fn(client)
        );
        return client;
      }

      function routeQueries(
        order: { id: string; total: number; status: string },
        calls: string[]
      ) {
        mockedQuery.mockImplementation(async (q: { text: string }) => {
          calls.push(`q:${q.text}`);
          if (q.text.includes("FROM orders")) return [order];
          return [];
        });
      }

      it("scopes the order lookup to the authenticated customer", async () => {
        mockedQuery.mockResolvedValueOnce([]);
        const res = await request(app)
          .post("/refunds")
          .set("Authorization", `Bearer ${token}`)
          .send({ reference: "ord_someone_else", amountDollars: 5 });
        expect(res.status).toBe(404);
        const lookup = mockedQuery.mock.calls[0][0];
        expect(lookup.text).toContain("customer_id");
        expect(lookup.values).toEqual(["ord_someone_else", "user-1"]);
        expect(mockedRefundProcessor).not.toHaveBeenCalled();
      });

      it("passes the refund amount to the processor in cents", async () => {
        const calls: string[] = [];
        routeQueries({ id: "order-1", total: 1999, status: "paid" }, calls);
        refundTransaction(0, calls);
        const res = await request(app)
          .post("/refunds")
          .set("Authorization", `Bearer ${token}`)
          .send({ reference: "ord_abc", amountDollars: 12.34 });
        expect(res.status).toBe(200);
        expect(mockedRefundProcessor).toHaveBeenCalledTimes(1);
        expect(mockedRefundProcessor.mock.calls[0][0].amount).toBe(1234);
      });

      it("rejects a refund exceeding the remaining refundable amount", async () => {
        const calls: string[] = [];
        routeQueries(
          { id: "order-1", total: 1999, status: "partially_refunded" },
          calls
        );
        const client = refundTransaction(1500, calls);
        const res = await request(app)
          .post("/refunds")
          .set("Authorization", `Bearer ${token}`)
          .send({ reference: "ord_abc", amountDollars: 5 });
        expect(res.status).toBe(422);
        expect(res.body.remaining).toBe(499);
        expect(mockedRefundProcessor).not.toHaveBeenCalled();
        expect(
          client.query.mock.calls.some((c: any[]) =>
            c[0].text.includes("INSERT INTO refunds")
          )
        ).toBe(false);
      });

      it("allows a further partial refund on a partially refunded order", async () => {
        const calls: string[] = [];
        routeQueries(
          { id: "order-1", total: 1999, status: "partially_refunded" },
          calls
        );
        refundTransaction(1000, calls);
        const res = await request(app)
          .post("/refunds")
          .set("Authorization", `Bearer ${token}`)
          .send({ reference: "ord_abc", amountDollars: 9.99 });
        expect(res.status).toBe(200);
        expect(res.body.amount).toBe(999);
      });

      it("marks a partial refund as partially_refunded, not refunded", async () => {
        const calls: string[] = [];
        routeQueries({ id: "order-1", total: 1999, status: "paid" }, calls);
        refundTransaction(0, calls);
        const res = await request(app)
          .post("/refunds")
          .set("Authorization", `Bearer ${token}`)
          .send({ reference: "ord_abc", amountDollars: 5 });
        expect(res.status).toBe(200);
        const orderUpdate = calls.find((c) => c.includes("UPDATE orders"));
        expect(orderUpdate).toBeDefined();
        expect(orderUpdate).toContain("'partially_refunded'");
        expect(orderUpdate).not.toMatch(/SET status = 'refunded'/);
      });

      it("records the refund as pending before calling the processor, then succeeded", async () => {
        const calls: string[] = [];
        routeQueries({ id: "order-1", total: 1999, status: "paid" }, calls);
        refundTransaction(0, calls);
        mockedRefundProcessor.mockImplementationOnce(async () => {
          calls.push("processor");
        });
        const res = await request(app)
          .post("/refunds")
          .set("Authorization", `Bearer ${token}`)
          .send({ reference: "ord_abc", amountDollars: 19.99 });
        expect(res.status).toBe(200);

        const insertIdx = calls.findIndex(
          (c) => c.startsWith("tx:") && c.includes("INSERT INTO refunds")
        );
        const processorIdx = calls.indexOf("processor");
        const succeededIdx = calls.findIndex(
          (c) => c.includes("UPDATE refunds") && c.includes("'succeeded'")
        );
        expect(calls[insertIdx]).toContain("'pending'");
        expect(insertIdx).toBeGreaterThanOrEqual(0);
        expect(processorIdx).toBeGreaterThan(insertIdx);
        expect(succeededIdx).toBeGreaterThan(processorIdx);
        // The processor is never called from inside the transaction callback.
        expect(calls[succeededIdx].startsWith("q:")).toBe(true);
      });

      it("marks the refund failed and returns 402 when the processor declines", async () => {
        const calls: string[] = [];
        routeQueries({ id: "order-1", total: 1999, status: "paid" }, calls);
        refundTransaction(0, calls);
        mockedRefundProcessor.mockRejectedValueOnce(
          new ProcessorError("declined")
        );
        const res = await request(app)
          .post("/refunds")
          .set("Authorization", `Bearer ${token}`)
          .send({ reference: "ord_abc", amountDollars: 5 });
        expect(res.status).toBe(402);
        expect(
          calls.some(
            (c) => c.includes("UPDATE refunds") && c.includes("'failed'")
          )
        ).toBe(true);
        expect(calls.some((c) => c.includes("UPDATE orders"))).toBe(false);
      });
    });
  });

  describe("POST /payments/capture-batch", () => {
    it("rejects an empty orderIds array", async () => {
      const res = await request(app)
        .post("/payments/capture-batch")
        .set("Authorization", `Bearer ${token}`)
        .send({ orderIds: [] });
      expect(res.status).toBe(400);
    });

    it("captures every matching order", async () => {
      mockedQuery.mockResolvedValueOnce([
        { id: "order-1", total: 500, status: "pending" },
        { id: "order-2", total: 700, status: "pending" },
      ]);
      mockedQuery.mockResolvedValue([]);
      const res = await request(app)
        .post("/payments/capture-batch")
        .set("Authorization", `Bearer ${token}`)
        .send({ orderIds: ["order-1", "order-2"] });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.captured.sort()).toEqual(["order-1", "order-2"]);
    });
  });
});
