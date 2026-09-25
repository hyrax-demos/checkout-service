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

// Wrap the processor boundary in spies (resolving, like the demo build) so
// tests can assert on exactly what the routes send upstream.
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

    describe("sends the refund amount to the processor in integer cents", () => {
      // Order total is large enough that none of these refunds trips the
      // over-refund check; this block is only about units.
      function paidOrder() {
        mockedQuery.mockImplementation(async (q: { text: string }) => {
          if (q.text.includes("FROM orders")) {
            return [{ id: "order-1", total: 100000, status: "paid" }];
          }
          return [];
        });
      }

      it.each([
        [12.34, 1234],
        [0.29, 29], // 0.29 * 100 === 28.999999999999996
        [19.99, 1999], // 19.99 * 100 === 1998.9999999999998
        [0.07, 7], // 0.07 * 100 === 7.000000000000001
        [5, 500],
      ])("refund of $%s -> %i cents", async (amountDollars, expectedCents) => {
        paidOrder();
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

        // The refunds ledger row records the same cents value.
        const insert = client.query.mock.calls
          .map((c: any[]) => c[0])
          .find((q: { text: string }) => q.text.includes("INSERT INTO refunds"));
        expect(insert).toBeDefined();
        expect(insert.values).toContain(expectedCents);
        expect(res.body.amount).toBe(expectedCents);
      });
    });

    describe("rejects refunds whose cumulative total would exceed the order total", () => {
      // A tiny in-memory refunds ledger shared by the pool-level `query` mock
      // and the transaction client, routed by SQL text. Orders' totals are in
      // cents, as are ledger amounts.
      type LedgerRow = { orderId: string; amount: number };
      let ledger: LedgerRow[];
      let txClients: { query: ReturnType<typeof vi.fn> }[];
      const orders: Record<string, { id: string; total: number; status: string }> = {
        ord_a: { id: "order-a", total: 5000, status: "paid" },
        ord_b: { id: "order-b", total: 5000, status: "paid" },
      };

      function route(q: { text: string; values: unknown[] }) {
        if (q.text.includes("FROM refunds")) {
          const orderId = q.values[0];
          const sum = ledger
            .filter((r) => r.orderId === orderId)
            .reduce((acc, r) => acc + r.amount, 0);
          // pg returns SUM() as a string.
          return [{ refunded: String(sum) }];
        }
        if (q.text.includes("INSERT INTO refunds")) {
          const [, orderId, amount] = q.values as [string, string, number];
          ledger.push({ orderId, amount });
          return [];
        }
        if (q.text.includes("FROM orders") && q.text.includes("reference")) {
          const order = orders[q.values[0] as string];
          return order ? [{ ...order }] : [];
        }
        return [];
      }

      beforeEach(() => {
        ledger = [];
        txClients = [];
        mockedQuery.mockImplementation(async (q: any) => route(q));
        mockedWithTransaction.mockImplementation(async (fn: any) => {
          const client = { query: vi.fn(async (q: any) => route(q)) };
          txClients.push(client);
          return fn(client);
        });
      });

      function refund(reference: string, amountDollars: number) {
        return request(app)
          .post("/refunds")
          .set("Authorization", `Bearer ${token}`)
          .send({ reference, amountDollars });
      }

      it("rejects a second partial refund that pushes the cumulative total over", async () => {
        const first = await refund("ord_a", 30);
        expect(first.status).toBe(200);
        expect(mockedRefundProcessor).toHaveBeenCalledTimes(1);

        const second = await refund("ord_a", 20.01);
        expect(second.status).toBe(422);
        expect(second.body).toEqual({ error: "refund exceeds order total" });
        // The processor was not called again and nothing new was recorded.
        expect(mockedRefundProcessor).toHaveBeenCalledTimes(1);
        expect(ledger).toEqual([{ orderId: "order-a", amount: 3000 }]);
        // No transaction was opened for the rejected refund, so the order
        // was not touched.
        expect(txClients).toHaveLength(1);
      });

      it("allows partial refunds that sum exactly to the order total", async () => {
        for (const amt of [10, 15.5, 24.5]) {
          const res = await refund("ord_a", amt);
          expect(res.status).toBe(200);
        }
        expect(mockedRefundProcessor).toHaveBeenCalledTimes(3);
        expect(ledger.reduce((acc, r) => acc + r.amount, 0)).toBe(5000);

        // Anything further is now over the total.
        const extra = await refund("ord_a", 0.01);
        expect(extra.status).toBe(422);
        expect(mockedRefundProcessor).toHaveBeenCalledTimes(3);
      });

      it("still rejects a single refund that alone exceeds the order total", async () => {
        const res = await refund("ord_a", 50.01);
        expect(res.status).toBe(422);
        expect(res.body).toEqual({ error: "refund exceeds order total" });
        expect(mockedRefundProcessor).not.toHaveBeenCalled();
        expect(ledger).toEqual([]);
        expect(txClients).toHaveLength(0);
      });

      it("does not count refunds on a different order", async () => {
        ledger.push({ orderId: "order-b", amount: 5000 });
        const res = await refund("ord_a", 50);
        expect(res.status).toBe(200);
        expect(mockedRefundProcessor).toHaveBeenCalledTimes(1);
        expect(mockedRefundProcessor.mock.calls[0][0].orderId).toBe("order-a");
      });

      it("re-checks under the row lock and rolls back without calling the processor", async () => {
        // Simulate a concurrent refund landing between the fast-path check
        // and the transaction: the ledger grows once the transaction opens.
        mockedWithTransaction.mockImplementationOnce(async (fn: any) => {
          ledger.push({ orderId: "order-a", amount: 4000 });
          const client = { query: vi.fn(async (q: any) => route(q)) };
          txClients.push(client);
          return fn(client);
        });
        const res = await refund("ord_a", 20);
        expect(res.status).toBe(422);
        expect(res.body).toEqual({ error: "refund exceeds order total" });
        expect(mockedRefundProcessor).not.toHaveBeenCalled();
        const texts = txClients[0].query.mock.calls.map((c: any[]) => c[0].text);
        expect(texts.some((t: string) => t.includes("FOR UPDATE"))).toBe(true);
        expect(texts.some((t: string) => t.includes("INSERT INTO refunds"))).toBe(false);
        expect(texts.some((t: string) => t.includes("UPDATE orders"))).toBe(false);
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
