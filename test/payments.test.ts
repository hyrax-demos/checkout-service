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

vi.mock("../src/processor", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/processor")>();
  return {
    ...actual,
    chargeProcessor: vi.fn().mockResolvedValue(undefined),
    refundProcessor: vi.fn().mockResolvedValue(undefined),
  };
});

import { query, withTransaction } from "../src/db";
import { refundProcessor } from "../src/processor";
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

    describe("passes integer cents to refundProcessor", () => {
      beforeEach(() => {
        mockedRefundProcessor.mockClear();
        mockedQuery.mockImplementation(async (q: { text: string }) => {
          if (q.text.includes("FROM orders")) {
            return [{ id: "order-1", total: 5000, status: "paid" }];
          }
          return [];
        });
      });

      // Each of these dollar values is not exactly representable as a
      // binary float, so a bare `dollars * 100` would not be an integer.
      it.each([
        [12.34, 1234],
        [0.29, 29],
        [19.99, 1999],
        [0.07, 7],
      ])("$%s -> %s cents", async (amountDollars, expectedCents) => {
        const client = fakeTransaction();
        const res = await request(app)
          .post("/refunds")
          .set("Authorization", `Bearer ${token}`)
          .send({ reference: "ord_abc", amountDollars });
        expect(res.status).toBe(200);

        expect(mockedRefundProcessor).toHaveBeenCalledTimes(1);
        const args = mockedRefundProcessor.mock.calls[0][0];
        expect(args.orderId).toBe("order-1");
        expect(args.amount).toBe(expectedCents);
        expect(Number.isInteger(args.amount)).toBe(true);

        // The refunds row is recorded in the same integer-cents unit.
        const insert = client.query.mock.calls
          .map((c: any[]) => c[0])
          .find((q: { text: string }) => q.text.includes("INSERT INTO refunds"));
        expect(insert).toBeDefined();
        expect(insert.values).toContain(expectedCents);
      });

      it("does not call refundProcessor when the refund exceeds the order total", async () => {
        const res = await request(app)
          .post("/refunds")
          .set("Authorization", `Bearer ${token}`)
          .send({ reference: "ord_abc", amountDollars: 50.01 });
        expect(res.status).toBe(422);
        expect(mockedRefundProcessor).not.toHaveBeenCalled();
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
