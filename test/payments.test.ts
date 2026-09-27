import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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

import { query, withTransaction } from "../src/db";
import { buildApp } from "./helpers/app";

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

    describe("platform-wide refund ceiling (REFUND_MAX_CENTS)", () => {
      function orderWithTotal(total: number) {
        mockedQuery.mockImplementation(async (q: { text: string }) => {
          if (q.text.includes("FROM orders")) {
            return [{ id: "order-1", total, status: "paid" }];
          }
          return [];
        });
      }

      function refund(amountDollars: number) {
        return request(app)
          .post("/refunds")
          .set("Authorization", `Bearer ${token}`)
          .send({ reference: "ord_abc", amountDollars });
      }

      afterEach(() => {
        vi.unstubAllEnvs();
      });

      it("defaults to 50000 cents when unset: rejects $500.01 with 422 and writes nothing", async () => {
        const saved = process.env.REFUND_MAX_CENTS;
        delete process.env.REFUND_MAX_CENTS;
        try {
          orderWithTotal(100000);
          const res = await refund(500.01);
          expect(res.status).toBe(422);
          expect(mockedWithTransaction).not.toHaveBeenCalled();
        } finally {
          if (saved !== undefined) process.env.REFUND_MAX_CENTS = saved;
        }
      });

      it("defaults to 50000 cents when empty: allows exactly $500.00", async () => {
        vi.stubEnv("REFUND_MAX_CENTS", "");
        orderWithTotal(100000);
        fakeTransaction();
        const res = await refund(500);
        expect(res.status).toBe(200);
        expect(res.body.amount).toBe(50000);
      });

      it("honours a configured ceiling: exactly at the ceiling is allowed", async () => {
        vi.stubEnv("REFUND_MAX_CENTS", "2500");
        orderWithTotal(10000);
        fakeTransaction();
        const res = await refund(25);
        expect(res.status).toBe(200);
        expect(res.body.amount).toBe(2500);
      });

      it("honours a configured ceiling: one cent over is rejected before the processor/transaction", async () => {
        vi.stubEnv("REFUND_MAX_CENTS", "2500");
        orderWithTotal(10000);
        const res = await refund(25.01);
        expect(res.status).toBe(422);
        expect(mockedWithTransaction).not.toHaveBeenCalled();
      });

      it("keeps the order total binding when it is below a high ceiling", async () => {
        vi.stubEnv("REFUND_MAX_CENTS", "100000000");
        orderWithTotal(1999);
        const res = await refund(20);
        expect(res.status).toBe(422);
        expect(res.body.error).toBe("refund exceeds order total");
        expect(mockedWithTransaction).not.toHaveBeenCalled();
      });

      it("does not change the existing 400/404/409 validation", async () => {
        vi.stubEnv("REFUND_MAX_CENTS", "1");

        const bad = await refund(0);
        expect(bad.status).toBe(400);

        mockedQuery.mockResolvedValueOnce([]);
        const missing = await refund(5);
        expect(missing.status).toBe(404);

        mockedQuery.mockResolvedValueOnce([
          { id: "order-1", total: 1999, status: "cancelled" },
        ]);
        const notRefundable = await refund(5);
        expect(notRefundable.status).toBe(409);
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
