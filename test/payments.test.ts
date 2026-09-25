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

    describe("passes the refund amount to the processor in integer cents", () => {
      const mockedRefundProcessor = refundProcessor as unknown as ReturnType<
        typeof vi.fn
      >;

      beforeEach(() => {
        mockedRefundProcessor.mockClear();
      });

      it.each([
        [19.99, 1999],
        [12.34, 1234],
        [0.29, 29],
        [5, 500],
      ])("%s dollars -> %s cents", async (amountDollars, expectedCents) => {
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
          .send({ reference: "ord_abc", amountDollars });
        expect(res.status).toBe(200);

        expect(mockedRefundProcessor).toHaveBeenCalledTimes(1);
        const args = mockedRefundProcessor.mock.calls[0][0];
        expect(args.orderId).toBe("order-1");
        expect(args.amount).toBe(expectedCents);
        expect(Number.isInteger(args.amount)).toBe(true);

        // The refunds row must record the same integer-cents amount.
        const insert = client.query.mock.calls
          .map((c: any[]) => c[0])
          .find((q: { text: string }) => q.text.includes("INSERT INTO refunds"));
        expect(insert).toBeDefined();
        // values: [refundId, orderId, amount]
        expect(insert.values[2]).toBe(expectedCents);
        expect(res.body.amount).toBe(expectedCents);
      });
    });

    describe("enforces the cumulative refunded total", () => {
      const mockedRefundProcessor = refundProcessor as unknown as ReturnType<
        typeof vi.fn
      >;

      // Stateful fake of the orders + refunds tables: SUM lookups (both the
      // pre-check via `query` and the locked re-check inside the transaction)
      // see refunds inserted by earlier requests. Mirrors pg by returning the
      // SUM as a string.
      function fakeRefundsDb(orderTotal: number, priorRefunds: number[] = []) {
        const refunds = [...priorRefunds];
        const route = async (q: { text: string; values: unknown[] }) => {
          if (q.text.includes("FROM refunds")) {
            return [{ refunded: String(refunds.reduce((a, b) => a + b, 0)) }];
          }
          if (q.text.includes("INSERT INTO refunds")) {
            refunds.push(q.values[2] as number);
            return [];
          }
          if (q.text.includes("FROM orders")) {
            return [{ id: "order-1", total: orderTotal, status: "paid" }];
          }
          return [];
        };
        mockedQuery.mockImplementation(route);
        mockedWithTransaction.mockImplementation(async (fn: any) =>
          fn({ query: vi.fn(route) })
        );
        return refunds;
      }

      function refund(amountDollars: number) {
        return request(app)
          .post("/refunds")
          .set("Authorization", `Bearer ${token}`)
          .send({ reference: "ord_abc", amountDollars });
      }

      beforeEach(() => {
        mockedRefundProcessor.mockClear();
      });

      it("allows two partial refunds that together equal the total", async () => {
        const refunds = fakeRefundsDb(1999);
        const first = await refund(10.0);
        expect(first.status).toBe(200);
        const second = await refund(9.99);
        expect(second.status).toBe(200);
        expect(second.body.amount).toBe(999);
        expect(mockedRefundProcessor).toHaveBeenCalledTimes(2);
        expect(refunds).toEqual([1000, 999]);
      });

      it("rejects a refund that would push the cumulative total over the order total", async () => {
        const refunds = fakeRefundsDb(1999);
        const first = await refund(15);
        expect(first.status).toBe(200);
        mockedRefundProcessor.mockClear();

        const second = await refund(5); // 1500 + 500 > 1999
        expect(second.status).toBe(422);
        expect(second.body).toEqual({
          error: "refund exceeds remaining refundable amount",
        });
        expect(mockedRefundProcessor).not.toHaveBeenCalled();
        expect(refunds).toEqual([1500]);
      });

      it("rejects inside the transaction when a concurrent refund landed after the pre-check", async () => {
        const refunds = fakeRefundsDb(1999, [1500]);
        // The pre-check sees no prior refunds (stale read); the locked
        // re-check inside the transaction sees the 1500 already recorded.
        mockedQuery.mockImplementation(async (q: { text: string }) => {
          if (q.text.includes("FROM refunds")) return [{ refunded: "0" }];
          if (q.text.includes("FROM orders")) {
            return [{ id: "order-1", total: 1999, status: "paid" }];
          }
          return [];
        });
        const res = await refund(5);
        expect(res.status).toBe(422);
        expect(mockedRefundProcessor).not.toHaveBeenCalled();
        expect(refunds).toEqual([1500]);
      });

      it("allows a refund for exactly the remaining amount", async () => {
        const refunds = fakeRefundsDb(1999, [1500]);
        const res = await refund(4.99);
        expect(res.status).toBe(200);
        expect(res.body.amount).toBe(499);
        expect(mockedRefundProcessor).toHaveBeenCalledTimes(1);
        expect(mockedRefundProcessor.mock.calls[0][0].amount).toBe(499);
        expect(refunds).toEqual([1500, 499]);
      });

      it("still rejects a single refund larger than the order total", async () => {
        const refunds = fakeRefundsDb(1999);
        const res = await refund(20);
        expect(res.status).toBe(422);
        expect(res.body).toEqual({ error: "refund exceeds order total" });
        expect(mockedRefundProcessor).not.toHaveBeenCalled();
        expect(refunds).toEqual([]);
      });

      it("treats a missing SUM row as zero prior refunds", async () => {
        mockedQuery.mockImplementation(async (q: { text: string }) => {
          if (q.text.includes("FROM orders")) {
            return [{ id: "order-1", total: 1999, status: "paid" }];
          }
          return [];
        });
        fakeTransaction();
        const res = await refund(19.99);
        expect(res.status).toBe(200);
        expect(mockedRefundProcessor).toHaveBeenCalledTimes(1);
      });
    });

    describe("sets the order status to refunded only once fully refunded", () => {
      // Stateful fake of the orders + refunds tables that also applies
      // `UPDATE orders SET status` writes, and records every status write so
      // tests can assert that a partial refund writes no status at all.
      function fakeOrderDb(orderTotal: number, priorRefunds: number[] = []) {
        const state = {
          status: "paid",
          refunds: [...priorRefunds],
          statusWrites: [] as { text: string; values: unknown[] }[],
        };
        const route = async (q: { text: string; values: unknown[] }) => {
          if (q.text.includes("FROM refunds")) {
            return [
              { refunded: String(state.refunds.reduce((a, b) => a + b, 0)) },
            ];
          }
          if (q.text.includes("INSERT INTO refunds")) {
            state.refunds.push(q.values[2] as number);
            return [];
          }
          if (q.text.includes("UPDATE orders SET status")) {
            state.statusWrites.push(q);
            if (q.text.includes("'refunded'")) state.status = "refunded";
            return [];
          }
          if (q.text.includes("FROM orders")) {
            return [{ id: "order-1", total: orderTotal, status: state.status }];
          }
          return [];
        };
        mockedQuery.mockImplementation(route);
        mockedWithTransaction.mockImplementation(async (fn: any) =>
          fn({ query: vi.fn(route) })
        );
        return state;
      }

      function refund(amountDollars: number) {
        return request(app)
          .post("/refunds")
          .set("Authorization", `Bearer ${token}`)
          .send({ reference: "ord_abc", amountDollars });
      }

      it("leaves the status unchanged after a partial refund", async () => {
        const state = fakeOrderDb(1999);
        const res = await refund(5);
        expect(res.status).toBe(200);
        expect(state.refunds).toEqual([500]);
        expect(state.status).toBe("paid");
        expect(state.statusWrites).toEqual([]);
      });

      it("sets refunded after a single full refund", async () => {
        const state = fakeOrderDb(1999);
        const res = await refund(19.99);
        expect(res.status).toBe(200);
        expect(state.status).toBe("refunded");
        expect(state.statusWrites).toHaveLength(1);
        expect(state.statusWrites[0].values).toEqual(["order-1"]);
      });

      it("sets refunded only after the second of two partials reaches the total", async () => {
        const state = fakeOrderDb(1999);
        const first = await refund(10);
        expect(first.status).toBe(200);
        expect(state.status).toBe("paid");
        expect(state.statusWrites).toEqual([]);

        const second = await refund(9.99);
        expect(second.status).toBe(200);
        expect(state.refunds).toEqual([1000, 999]);
        expect(state.status).toBe("refunded");
        expect(state.statusWrites).toHaveLength(1);
      });

      it("sets refunded when a refund covers exactly the remaining amount", async () => {
        const state = fakeOrderDb(1999, [1500]);
        const res = await refund(4.99);
        expect(res.status).toBe(200);
        expect(state.status).toBe("refunded");
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
