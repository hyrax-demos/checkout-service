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
    chargeProcessor: vi.fn(actual.chargeProcessor),
    refundProcessor: vi.fn(actual.refundProcessor),
  };
});

import { query, withTransaction } from "../src/db";
import { refundProcessor } from "../src/processor";
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

    it("passes the refund amount to the processor in integer cents", async () => {
      const mockedRefundProcessor = refundProcessor as unknown as ReturnType<
        typeof vi.fn
      >;
      mockedRefundProcessor.mockClear();
      mockedQuery.mockImplementation(async (q: { text: string }) => {
        if (q.text.includes("FROM orders")) {
          return [{ id: "order-1", total: 5000, status: "paid" }];
        }
        return [];
      });
      fakeTransaction();
      const res = await request(app)
        .post("/refunds")
        .set("Authorization", `Bearer ${token}`)
        .send({ reference: "ord_abc", amountDollars: 19.99 });
      expect(res.status).toBe(200);
      expect(mockedRefundProcessor).toHaveBeenCalledTimes(1);
      const args = mockedRefundProcessor.mock.calls[0][0];
      expect(args.orderId).toBe("order-1");
      // 19.99 * 100 is 1998.9999... in floating point; it must round, not
      // truncate, and must not be the dollar value.
      expect(args.amount).toBe(1999);
      expect(Number.isInteger(args.amount)).toBe(true);
    });
  });

  describe("POST /refunds cumulative limit", () => {
    const mockedRefundProcessor = refundProcessor as unknown as ReturnType<
      typeof vi.fn
    >;

    // Stateful in-memory stand-in for the orders/refunds tables, shared by
    // the pool-level `query` mock and every transaction client, so refund
    // rows written by one request are visible to the next.
    let orders: { id: string; reference: string; total: number; status: string }[];
    let refunds: { id: string; order_id: string; amount: number }[];

    function run(q: { text: string; values: unknown[] }) {
      if (q.text.includes("FROM orders WHERE reference")) {
        return orders.filter((o) => o.reference === q.values[0]);
      }
      if (q.text.includes("SUM(amount)") && q.text.includes("FROM refunds")) {
        const total = refunds
          .filter((r) => r.order_id === q.values[0])
          .reduce((acc, r) => acc + r.amount, 0);
        // pg returns SUM over an integer column as a bigint string.
        return [{ refunded: String(total) }];
      }
      if (q.text.includes("INSERT INTO refunds")) {
        const [id, order_id, amount] = q.values as [string, string, number];
        refunds.push({ id, order_id, amount });
        return [];
      }
      return [];
    }

    beforeEach(() => {
      orders = [
        { id: "order-1", reference: "ord_one", total: 5000, status: "paid" },
        { id: "order-2", reference: "ord_two", total: 5000, status: "paid" },
      ];
      refunds = [];
      mockedRefundProcessor.mockClear();
      mockedQuery.mockImplementation(async (q: any) => run(q));
      mockedWithTransaction.mockImplementation(async (fn: any) =>
        fn({ query: vi.fn(async (q: any) => run(q)) })
      );
    });

    function refund(reference: string, amountDollars: number) {
      return request(app)
        .post("/refunds")
        .set("Authorization", `Bearer ${token}`)
        .send({ reference, amountDollars });
    }

    it("allows two partial refunds that stay under the total", async () => {
      const first = await refund("ord_one", 20);
      const second = await refund("ord_one", 15.5);
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(mockedRefundProcessor).toHaveBeenCalledTimes(2);
      expect(refunds.map((r) => r.amount)).toEqual([2000, 1550]);
      expect(refunds.every((r) => r.order_id === "order-1")).toBe(true);
    });

    it("rejects a refund that would push the cumulative total over the order total", async () => {
      const first = await refund("ord_one", 30);
      expect(first.status).toBe(200);
      mockedRefundProcessor.mockClear();

      // 3000 + 2001 = 5001 > 5000, though 2001 alone is within the total.
      const second = await refund("ord_one", 20.01);
      expect(second.status).toBe(422);
      expect(second.body).toEqual({ error: "refund exceeds order total" });
      expect(mockedRefundProcessor).not.toHaveBeenCalled();
      expect(refunds).toHaveLength(1);
      expect(refunds[0].amount).toBe(3000);
    });

    it("rejects inside the transaction if the locked re-check finds the limit exceeded", async () => {
      // Simulate a concurrent refund committing between the early check and
      // the locked re-check inside the transaction.
      mockedWithTransaction.mockImplementationOnce(async (fn: any) => {
        refunds.push({ id: "concurrent", order_id: "order-1", amount: 4000 });
        return fn({ query: vi.fn(async (q: any) => run(q)) });
      });
      const res = await refund("ord_one", 20);
      expect(res.status).toBe(422);
      expect(res.body).toEqual({ error: "refund exceeds order total" });
      expect(mockedRefundProcessor).not.toHaveBeenCalled();
      expect(refunds.map((r) => r.id)).toEqual(["concurrent"]);
    });

    it("allows a refund that brings the cumulative total exactly to the order total", async () => {
      expect((await refund("ord_one", 19.99)).status).toBe(200);
      // 1999 + 3001 = 5000 exactly.
      const res = await refund("ord_one", 30.01);
      expect(res.status).toBe(200);
      expect(res.body.amount).toBe(3001);
      expect(refunds.reduce((a, r) => a + r.amount, 0)).toBe(5000);
    });

    it("does not count refunds on a different order toward this order's limit", async () => {
      expect((await refund("ord_two", 50)).status).toBe(200);
      const res = await refund("ord_one", 50);
      expect(res.status).toBe(200);
      expect(refunds.map((r) => [r.order_id, r.amount])).toEqual([
        ["order-2", 5000],
        ["order-1", 5000],
      ]);
    });

    it("still rejects a single refund larger than the order total", async () => {
      const res = await refund("ord_one", 50.01);
      expect(res.status).toBe(422);
      expect(mockedRefundProcessor).not.toHaveBeenCalled();
      expect(refunds).toHaveLength(0);
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
