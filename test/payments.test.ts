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
const mockedWithTransaction = withTransaction as unknown as ReturnType<
  typeof vi.fn
>;
const mockedRefundProcessor = refundProcessor as unknown as ReturnType<
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

    describe("amount units", () => {
      // Route the order lookup by SQL text (see the full-refund test above)
      // so this stays valid if later work adds a prior-refunds query.
      function paidOrder(total: number) {
        mockedQuery.mockImplementation(async (q: { text: string }) => {
          if (q.text.includes("FROM orders")) {
            return [{ id: "order-1", total, status: "paid" }];
          }
          return [];
        });
      }

      function insertedRefundAmount(client: { query: ReturnType<typeof vi.fn> }) {
        const insert = client.query.mock.calls
          .map((c) => c[0] as { text: string; values: unknown[] })
          .find((q) => q.text.includes("INSERT INTO refunds"));
        expect(insert).toBeDefined();
        // Values are (id, order_id, amount).
        return insert!.values[2];
      }

      it("passes integer cents to refundProcessor (12.34 dollars -> 1234)", async () => {
        paidOrder(5000);
        const client = fakeTransaction();
        const res = await request(app)
          .post("/refunds")
          .set("Authorization", `Bearer ${token}`)
          .send({ reference: "ord_abc", amountDollars: 12.34 });
        expect(res.status).toBe(200);
        expect(mockedRefundProcessor).toHaveBeenCalledTimes(1);
        expect(mockedRefundProcessor).toHaveBeenCalledWith(
          expect.objectContaining({ orderId: "order-1", amount: 1234 })
        );
        expect(insertedRefundAmount(client)).toBe(1234);
        expect(res.body.amount).toBe(1234);
      });

      it("rounds float artefacts to exact cents (0.29 dollars -> 29)", async () => {
        // 0.29 * 100 === 28.999999999999996 in IEEE-754.
        paidOrder(5000);
        const client = fakeTransaction();
        const res = await request(app)
          .post("/refunds")
          .set("Authorization", `Bearer ${token}`)
          .send({ reference: "ord_abc", amountDollars: 0.29 });
        expect(res.status).toBe(200);
        const { amount } = mockedRefundProcessor.mock.calls[0][0];
        expect(amount).toBe(29);
        expect(Number.isInteger(amount)).toBe(true);
        expect(insertedRefundAmount(client)).toBe(29);
      });
    });
    describe("cumulative refund limit", () => {
      type Q = { text: string; values: unknown[] };
      type RefundRow = { order_id: string; amount: number };

      // A tiny in-memory stand-in for the orders + refunds tables, shared by
      // the pooled `query` mock and every fake transaction client, so a
      // refund inserted by one request is visible to the next one's sum.
      function fakeDb(order: { id: string; total: number }, refunds: RefundRow[]) {
        const run = async (q: Q) => {
          if (q.text.includes("FROM refunds")) {
            const orderId = q.values[0];
            const sum = refunds
              .filter((r) => r.order_id === orderId)
              .reduce((acc, r) => acc + r.amount, 0);
            // pg returns SUM(integer) as a bigint string.
            return [{ refunded: String(sum) }];
          }
          if (q.text.includes("INSERT INTO refunds")) {
            refunds.push({
              order_id: q.values[1] as string,
              amount: q.values[2] as number,
            });
            return [];
          }
          if (q.text.includes("FROM orders")) {
            return [{ ...order, status: "paid" }];
          }
          return [];
        };
        mockedQuery.mockImplementation(run);
        const clients: Array<{ query: ReturnType<typeof vi.fn> }> = [];
        mockedWithTransaction.mockImplementation(async (fn: any) => {
          const client = { query: vi.fn().mockImplementation(run) };
          clients.push(client);
          return fn(client);
        });
        return { refunds, clients };
      }

      function insertCalls(clients: Array<{ query: ReturnType<typeof vi.fn> }>) {
        return clients.flatMap((c) =>
          c.query.mock.calls
            .map((call) => call[0] as Q)
            .filter((q) => q.text.includes("INSERT INTO refunds"))
        );
      }

      function refund(amountDollars: number) {
        return request(app)
          .post("/refunds")
          .set("Authorization", `Bearer ${token}`)
          .send({ reference: "ord_abc", amountDollars });
      }

      it("allows two partial refunds that together equal the total", async () => {
        const db = fakeDb({ id: "order-1", total: 1000 }, []);

        const first = await refund(4);
        expect(first.status).toBe(200);
        expect(first.body.amount).toBe(400);

        const second = await refund(6);
        expect(second.status).toBe(200);
        expect(second.body.amount).toBe(600);

        expect(mockedRefundProcessor).toHaveBeenCalledTimes(2);
        expect(db.refunds).toEqual([
          { order_id: "order-1", amount: 400 },
          { order_id: "order-1", amount: 600 },
        ]);
      });

      it("rejects a refund that pushes the cumulative total over the order total", async () => {
        const db = fakeDb({ id: "order-1", total: 1000 }, [
          { order_id: "order-1", amount: 700 },
        ]);

        // 5.00 alone is under the 10.00 total, but 7.00 + 5.00 exceeds it.
        const res = await refund(5);
        expect(res.status).toBe(422);
        expect(res.body).toEqual({ error: "refund exceeds order total" });
        expect(mockedRefundProcessor).not.toHaveBeenCalled();
        expect(insertCalls(db.clients)).toHaveLength(0);
        expect(db.refunds).toHaveLength(1);
      });

      it("rejects under the row lock when a refund landed after the pre-check", async () => {
        const refunds: RefundRow[] = [];
        const db = fakeDb({ id: "order-1", total: 1000 }, refunds);
        // Simulate a concurrent refund committing between the unlocked
        // pre-check and this request's locked re-check.
        const inner = mockedWithTransaction.getMockImplementation()!;
        mockedWithTransaction.mockImplementationOnce(async (fn: any) => {
          refunds.push({ order_id: "order-1", amount: 700 });
          return inner(fn);
        });

        const res = await refund(5);
        expect(res.status).toBe(422);
        expect(res.body).toEqual({ error: "refund exceeds order total" });
        expect(mockedRefundProcessor).not.toHaveBeenCalled();
        expect(insertCalls(db.clients)).toHaveLength(0);
        const lock = db.clients[0].query.mock.calls
          .map((call) => call[0] as Q)
          .find((q) => q.text.includes("FOR UPDATE"));
        expect(lock).toBeDefined();
      });

      it("does not count refunds issued against other orders", async () => {
        const db = fakeDb({ id: "order-1", total: 1000 }, [
          { order_id: "order-2", amount: 900 },
          { order_id: "order-3", amount: 1000 },
        ]);

        const res = await refund(10);
        expect(res.status).toBe(200);
        expect(res.body.amount).toBe(1000);
        expect(mockedRefundProcessor).toHaveBeenCalledTimes(1);
        expect(insertCalls(db.clients)).toHaveLength(1);
      });

      it("still rejects a single refund over the order total", async () => {
        const db = fakeDb({ id: "order-1", total: 1000 }, []);

        const res = await refund(10.01);
        expect(res.status).toBe(422);
        expect(res.body).toEqual({ error: "refund exceeds order total" });
        expect(mockedRefundProcessor).not.toHaveBeenCalled();
        expect(insertCalls(db.clients)).toHaveLength(0);
      });

      describe("order status", () => {
        function statusUpdates(
          clients: Array<{ query: ReturnType<typeof vi.fn> }>
        ) {
          const inTx = clients.flatMap((c) =>
            c.query.mock.calls.map((call) => call[0] as Q)
          );
          const pooled = mockedQuery.mock.calls.map((call) => call[0] as Q);
          return [...pooled, ...inTx].filter(
            (q) => q.text.includes("UPDATE orders") && q.text.includes("status")
          );
        }

        it("leaves the status unchanged after a partial refund", async () => {
          const db = fakeDb({ id: "order-1", total: 1000 }, []);

          const res = await refund(4);
          expect(res.status).toBe(200);
          expect(db.refunds).toEqual([{ order_id: "order-1", amount: 400 }]);
          // No status write at all: the order stays 'paid'.
          expect(statusUpdates(db.clients)).toHaveLength(0);
        });

        it("marks the order refunded when a single refund equals the total", async () => {
          const db = fakeDb({ id: "order-1", total: 1000 }, []);

          const res = await refund(10);
          expect(res.status).toBe(200);
          const updates = statusUpdates(db.clients);
          expect(updates).toHaveLength(1);
          expect(updates[0].text).toContain("'refunded'");
          expect(updates[0].values).toContain("order-1");
        });

        it("marks the order refunded when a second partial refund reaches the total", async () => {
          const db = fakeDb({ id: "order-1", total: 1000 }, []);

          const first = await refund(4);
          expect(first.status).toBe(200);
          expect(statusUpdates(db.clients)).toHaveLength(0);

          const second = await refund(6);
          expect(second.status).toBe(200);
          const updates = statusUpdates(db.clients);
          expect(updates).toHaveLength(1);
          expect(updates[0].text).toContain("'refunded'");
          // The status write happens in the second request's transaction.
          const secondTx = db.clients[1].query.mock.calls.map(
            (call) => call[0] as Q
          );
          expect(secondTx).toContain(updates[0]);
        });
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
