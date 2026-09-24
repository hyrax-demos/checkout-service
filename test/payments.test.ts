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

// Keep the real module (so `ProcessorError` stays a real class for the
// route's `instanceof` checks) but spy on the processor calls.
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
          return [{ id: "order-1", total: 1999, status: "paid" }];
        }
        return [];
      });
      const client = fakeTransaction();
      const res = await request(app)
        .post("/refunds")
        .set("Authorization", `Bearer ${token}`)
        .send({ reference: "ord_abc", amountDollars: 19.99 });
      expect(res.status).toBe(200);

      // 19.99 * 100 === 1998.9999999999998 in floating point; the processor
      // must receive exactly 1999 cents, never dollars or a float.
      expect(mockedRefundProcessor).toHaveBeenCalledTimes(1);
      const args = mockedRefundProcessor.mock.calls[0][0];
      expect(args).toMatchObject({ orderId: "order-1", amount: 1999 });
      expect(Number.isInteger(args.amount)).toBe(true);

      // The refunds row is recorded in the same integer cents.
      const insert = client.query.mock.calls
        .map((c: any[]) => c[0])
        .find((q: { text: string }) => q.text.includes("INSERT INTO refunds"));
      expect(insert).toBeDefined();
      expect(insert.values).toContain(1999);
    });
  });

  describe("POST /refunds cumulative limit", () => {
    // A tiny stateful fake of the orders/refunds tables, shared by the
    // top-level `query` and the transaction client, so a refund inserted by
    // one request is visible to the prior-total sum of the next.
    function fakeRefundsDb(order: { id: string; total: number; status: string }) {
      const refunds: { orderId: string; amount: number }[] = [];
      const run = async (q: { text: string; values: unknown[] }) => {
        if (q.text.includes("INSERT INTO refunds")) {
          const [, orderId, amount] = q.values as [string, string, number];
          refunds.push({ orderId, amount });
          return [];
        }
        if (q.text.includes("FROM refunds")) {
          const [orderId] = q.values as [string];
          const sum = refunds
            .filter((r) => r.orderId === orderId)
            .reduce((acc, r) => acc + r.amount, 0);
          // pg returns SUM(bigint) as a string.
          return [{ refunded: String(sum) }];
        }
        if (q.text.includes("FROM orders")) {
          return [{ ...order }];
        }
        return [];
      };
      mockedQuery.mockImplementation(run);
      mockedWithTransaction.mockImplementation(async (fn: any) =>
        fn({ query: vi.fn(run) })
      );
      return refunds;
    }

    const refund = (amountDollars: number) =>
      request(app)
        .post("/refunds")
        .set("Authorization", `Bearer ${token}`)
        .send({ reference: "ord_abc", amountDollars });

    it("allows two partial refunds that together equal the order total", async () => {
      const refunds = fakeRefundsDb({ id: "order-1", total: 1999, status: "paid" });

      const first = await refund(10.0);
      expect(first.status).toBe(200);
      expect(first.body.amount).toBe(1000);

      const second = await refund(9.99);
      expect(second.status).toBe(200);
      expect(second.body.amount).toBe(999);

      expect(mockedRefundProcessor).toHaveBeenCalledTimes(2);
      expect(refunds).toEqual([
        { orderId: "order-1", amount: 1000 },
        { orderId: "order-1", amount: 999 },
      ]);
    });

    it("rejects a refund that would push the cumulative total over the order total", async () => {
      const refunds = fakeRefundsDb({ id: "order-1", total: 1999, status: "paid" });

      const first = await refund(15.0);
      expect(first.status).toBe(200);
      expect(mockedRefundProcessor).toHaveBeenCalledTimes(1);

      // 1500 already refunded + 500 = 2000 > 1999.
      const second = await refund(5.0);
      expect(second.status).toBe(422);
      expect(second.body).toEqual({ error: "refund exceeds order total" });

      // The rejected refund never reached the processor or the refunds table.
      expect(mockedRefundProcessor).toHaveBeenCalledTimes(1);
      expect(refunds).toEqual([{ orderId: "order-1", amount: 1500 }]);
    });

    it("rejects over-refund caught only inside the transaction", async () => {
      // Simulates a concurrent refund committing between the early check and
      // the locked re-check: the pre-transaction read sees nothing, the
      // in-transaction sum sees 1500 already refunded.
      mockedQuery.mockImplementation(async (q: { text: string }) => {
        if (q.text.includes("FROM orders")) {
          return [{ id: "order-1", total: 1999, status: "paid" }];
        }
        return [{ refunded: "0" }];
      });
      const client = {
        query: vi.fn(async (q: { text: string }) =>
          q.text.includes("FROM refunds") ? [{ refunded: "1500" }] : []
        ),
      };
      mockedWithTransaction.mockImplementationOnce(async (fn: any) => fn(client));

      const res = await refund(5.0);
      expect(res.status).toBe(422);
      expect(mockedRefundProcessor).not.toHaveBeenCalled();
      const texts = client.query.mock.calls.map((c: any[]) => c[0].text);
      expect(texts.some((t: string) => t.includes("INSERT INTO refunds"))).toBe(false);
      expect(texts.some((t: string) => t.includes("UPDATE orders"))).toBe(false);
    });

    it("still rejects a single refund that exceeds the order total", async () => {
      const refunds = fakeRefundsDb({ id: "order-1", total: 1999, status: "paid" });

      const res = await refund(20.0);
      expect(res.status).toBe(422);
      expect(res.body).toEqual({ error: "refund exceeds order total" });
      expect(mockedRefundProcessor).not.toHaveBeenCalled();
      expect(refunds).toEqual([]);
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
