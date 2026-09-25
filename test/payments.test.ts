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

const mockedQuery = query as unknown as ReturnType<typeof vi.fn>;
const mockedRefundProcessor = refundProcessor as unknown as ReturnType<
  typeof vi.fn
>;
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
    mockedRefundProcessor.mockClear();
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

    it("passes the refund amount to the processor in integer cents", async () => {
      mockedQuery.mockImplementation(async (q: { text: string }) => {
        if (q.text.includes("FROM orders")) {
          return [{ id: "order-1", total: 5000, status: "paid" }];
        }
        return [];
      });
      const client = fakeTransaction();
      const res = await request(app)
        .post("/refunds")
        .set("Authorization", `Bearer ${token}`)
        .send({ reference: "ord_abc", amountDollars: 12.34 });
      expect(res.status).toBe(200);
      expect(mockedRefundProcessor).toHaveBeenCalledTimes(1);
      const args = mockedRefundProcessor.mock.calls[0][0];
      expect(args).toMatchObject({ orderId: "order-1", amount: 1234 });
      expect(Number.isInteger(args.amount)).toBe(true);
      // The refunds row is recorded in cents too, matching the processor.
      const insert = client.query.mock.calls
        .map(([q]: [{ text: string; values: unknown[] }]) => q)
        .find((q: { text: string }) => q.text.includes("INSERT INTO refunds"));
      expect(insert?.values).toContain(1234);
    });
  });

  describe("POST /refunds cumulative limit", () => {
    // Stateful fake of the orders/refunds tables: rows inserted by one
    // request's transaction are visible to the next request's SUM, both via
    // `query` and via the transaction client.
    function fakeRefundsDb(order: { id: string; total: number; status: string }) {
      const refunds: { order_id: unknown; amount: number }[] = [];
      const run = async (q: { text: string; values: unknown[] }) => {
        if (q.text.includes("FROM refunds")) {
          const orderId = q.values[0];
          const sum = refunds
            .filter((r) => r.order_id === orderId)
            .reduce((acc, r) => acc + r.amount, 0);
          // pg returns SUM(...) as a string.
          return [{ refunded: String(sum) }];
        }
        if (q.text.includes("INSERT INTO refunds")) {
          const [, orderId, amount] = q.values;
          refunds.push({ order_id: orderId, amount: amount as number });
          return [];
        }
        if (q.text.includes("UPDATE orders SET status = 'refunded'")) {
          if (q.values[0] === order.id) order.status = "refunded";
          return [];
        }
        if (q.text.includes("FROM orders")) {
          return [order];
        }
        return [];
      };
      mockedQuery.mockImplementation(run);
      mockedWithTransaction.mockImplementation(async (fn: any) =>
        fn({ query: vi.fn(run) })
      );
      return refunds;
    }

    function refund(amountDollars: number) {
      return request(app)
        .post("/refunds")
        .set("Authorization", `Bearer ${token}`)
        .send({ reference: "ord_abc", amountDollars });
    }

    it("allows a first partial refund and records it in cents", async () => {
      const refunds = fakeRefundsDb({ id: "order-1", total: 5000, status: "paid" });
      const res = await refund(20);
      expect(res.status).toBe(200);
      expect(res.body.amount).toBe(2000);
      expect(mockedRefundProcessor).toHaveBeenCalledTimes(1);
      expect(refunds).toEqual([{ order_id: "order-1", amount: 2000 }]);
    });

    it("rejects a second refund that would push the cumulative total over order.total", async () => {
      const refunds = fakeRefundsDb({ id: "order-1", total: 5000, status: "paid" });
      expect((await refund(30)).status).toBe(200);
      mockedRefundProcessor.mockClear();

      const res = await refund(20.01);
      expect(res.status).toBe(422);
      expect(res.body).toEqual({ error: "refund exceeds order total" });
      expect(mockedRefundProcessor).not.toHaveBeenCalled();
      expect(refunds).toEqual([{ order_id: "order-1", amount: 3000 }]);
    });

    it("allows a second refund that brings the cumulative total exactly to order.total", async () => {
      const refunds = fakeRefundsDb({ id: "order-1", total: 5000, status: "paid" });
      expect((await refund(30)).status).toBe(200);
      const res = await refund(20);
      expect(res.status).toBe(200);
      expect(mockedRefundProcessor).toHaveBeenCalledTimes(2);
      expect(refunds.reduce((acc, r) => acc + r.amount, 0)).toBe(5000);
    });

    it("still rejects a single refund above order.total", async () => {
      const refunds = fakeRefundsDb({ id: "order-1", total: 5000, status: "paid" });
      const res = await refund(50.01);
      expect(res.status).toBe(422);
      expect(mockedRefundProcessor).not.toHaveBeenCalled();
      expect(refunds).toEqual([]);
    });

    it("re-checks under the transaction and rejects if a concurrent refund landed first", async () => {
      fakeRefundsDb({ id: "order-1", total: 5000, status: "paid" });
      // Pre-transaction sum sees nothing; the locked re-sum sees 4000 cents.
      const txQuery = vi.fn(async (q: { text: string }) =>
        q.text.includes("FROM refunds") ? [{ refunded: "4000" }] : []
      );
      mockedWithTransaction.mockImplementation(async (fn: any) =>
        fn({ query: txQuery })
      );
      const res = await refund(20);
      expect(res.status).toBe(422);
      expect(mockedRefundProcessor).not.toHaveBeenCalled();
      expect(
        txQuery.mock.calls.some(([q]) => q.text.includes("INSERT INTO refunds"))
      ).toBe(false);
    });

    describe("order status", () => {
      it("leaves the order's status unchanged after a partial refund", async () => {
        const order = { id: "order-1", total: 5000, status: "paid" };
        fakeRefundsDb(order);
        const res = await refund(20);
        expect(res.status).toBe(200);
        expect(order.status).toBe("paid");
      });

      it("marks the order refunded only after the partial refund that reaches order.total", async () => {
        const order = { id: "order-1", total: 5000, status: "paid" };
        const refunds = fakeRefundsDb(order);

        expect((await refund(10)).status).toBe(200);
        expect(order.status).toBe("paid");
        expect((await refund(15.5)).status).toBe(200);
        expect(order.status).toBe("paid");
        expect((await refund(24.5)).status).toBe(200);
        expect(refunds.reduce((acc, r) => acc + r.amount, 0)).toBe(5000);
        expect(order.status).toBe("refunded");
      });

      it("marks the order refunded after a single full refund", async () => {
        const order = { id: "order-1", total: 1999, status: "paid" };
        fakeRefundsDb(order);
        const res = await refund(19.99);
        expect(res.status).toBe(200);
        expect(order.status).toBe("refunded");
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
