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

// Keep the real ProcessorError class, but spy on the processor calls so tests
// can assert on the amounts crossing the processor boundary.
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

    describe("amount units (integer cents)", () => {
      // Route the order lookup by SQL text, as above, so an additional
      // prior-refund-total lookup (added in a later step) defaults to no rows.
      function paidOrder(total: number) {
        mockedQuery.mockImplementation(async (q: { text: string }) => {
          if (q.text.includes("FROM orders")) {
            return [{ id: "order-1", total, status: "paid" }];
          }
          return [];
        });
      }

      async function refund(amountDollars: number) {
        return request(app)
          .post("/refunds")
          .set("Authorization", `Bearer ${token}`)
          .send({ reference: "ord_abc", amountDollars });
      }

      it("passes integer cents, not dollars, to refundProcessor", async () => {
        paidOrder(5000);
        fakeTransaction();
        const res = await refund(12.34);
        expect(res.status).toBe(200);
        expect(mockedRefundProcessor).toHaveBeenCalledTimes(1);
        const args = mockedRefundProcessor.mock.calls[0][0];
        expect(args.amount).toBe(1234);
        expect(Number.isInteger(args.amount)).toBe(true);
        expect(args.orderId).toBe("order-1");
      });

      it.each([
        [19.99, 1999],
        [0.29, 29],
        [0.07, 7],
      ])(
        "rounds %s dollars to exactly %s cents despite floating-point error",
        async (amountDollars, expectedCents) => {
          paidOrder(5000);
          fakeTransaction();
          const res = await refund(amountDollars);
          expect(res.status).toBe(200);
          const args = mockedRefundProcessor.mock.calls[0][0];
          expect(args.amount).toBe(expectedCents);
          expect(Number.isInteger(args.amount)).toBe(true);
          expect(res.body.amount).toBe(expectedCents);
        }
      );

      it("records the refund row's amount in cents", async () => {
        paidOrder(5000);
        const client = fakeTransaction();
        const res = await refund(12.34);
        expect(res.status).toBe(200);
        const insert = client.query.mock.calls
          .map(([q]: [{ text: string; values: unknown[] }]) => q)
          .find((q) => q.text.includes("INSERT INTO refunds"));
        expect(insert).toBeDefined();
        // (id, order_id, amount)
        expect(insert!.values[1]).toBe("order-1");
        expect(insert!.values[2]).toBe(1234);
        expect(insert!.values[0]).toBe(res.body.refundId);
      });

      it("compares the refund against order.total in cents", async () => {
        // order.total is 1999 cents ($19.99); $20.00 is 2000 cents.
        paidOrder(1999);
        const res = await refund(20);
        expect(res.status).toBe(422);
        expect(mockedRefundProcessor).not.toHaveBeenCalled();
        expect(mockedWithTransaction).not.toHaveBeenCalled();
      });
    });

    describe("cumulative refund guard", () => {
      // An in-memory stand-in for the refunds table, shared by the fake
      // transaction client so sequential requests see each other's rows.
      // SUM is returned as a string, as `pg` does for numeric/bigint results.
      function refundsStore(total: number, priorAmounts: number[]) {
        const rows = priorAmounts.map((amount, i) => ({
          id: `prior-${i}`,
          order_id: "order-1",
          amount,
        }));
        mockedQuery.mockImplementation(async (q: { text: string }) => {
          if (q.text.includes("FROM orders")) {
            return [{ id: "order-1", total, status: "paid" }];
          }
          return [];
        });
        const client = {
          query: vi.fn(async (q: { text: string; values: unknown[] }) => {
            if (q.text.includes("SUM(amount)") && q.text.includes("FROM refunds")) {
              const sum = rows
                .filter((r) => r.order_id === q.values[0])
                .reduce((acc, r) => acc + r.amount, 0);
              return [{ total: String(sum) }];
            }
            if (q.text.includes("INSERT INTO refunds")) {
              const [id, order_id, amount] = q.values as [string, string, number];
              rows.push({ id, order_id, amount });
            }
            return [];
          }),
        };
        mockedWithTransaction.mockImplementation(async (fn: any) => fn(client));
        return { rows, client };
      }

      function inserts(client: { query: ReturnType<typeof vi.fn> }) {
        return client.query.mock.calls
          .map(([q]: [{ text: string }]) => q)
          .filter((q) => q.text.includes("INSERT INTO refunds"));
      }

      async function refundCents(cents: number) {
        return request(app)
          .post("/refunds")
          .set("Authorization", `Bearer ${token}`)
          .send({ reference: "ord_abc", amountDollars: cents / 100 });
      }

      it("rejects a refund that would push the cumulative total past order.total", async () => {
        const { rows, client } = refundsStore(1000, [600]);
        const res = await refundCents(500);
        expect(res.status).toBe(422);
        expect(res.body).toEqual({ error: "refund exceeds order total" });
        expect(mockedRefundProcessor).not.toHaveBeenCalled();
        expect(inserts(client)).toHaveLength(0);
        expect(rows).toHaveLength(1);
      });

      it("allows a refund for exactly the remaining balance", async () => {
        const { rows, client } = refundsStore(1000, [600]);
        const res = await refundCents(400);
        expect(res.status).toBe(200);
        expect(res.body.refunded).toBe(true);
        expect(res.body.amount).toBe(400);
        expect(mockedRefundProcessor).toHaveBeenCalledTimes(1);
        expect(mockedRefundProcessor.mock.calls[0][0].amount).toBe(400);
        expect(inserts(client)).toHaveLength(1);
        expect(rows.map((r) => r.amount)).toEqual([600, 400]);
      });

      it("behaves as before for an order with no prior refunds", async () => {
        const { rows } = refundsStore(1000, []);
        const ok = await refundCents(1000);
        expect(ok.status).toBe(200);
        expect(ok.body.amount).toBe(1000);
        expect(rows.map((r) => r.amount)).toEqual([1000]);
      });

      it("still rejects a single refund above order.total with no prior refunds", async () => {
        const { client } = refundsStore(1000, []);
        const res = await refundCents(1001);
        expect(res.status).toBe(422);
        expect(res.body).toEqual({ error: "refund exceeds order total" });
        expect(mockedRefundProcessor).not.toHaveBeenCalled();
        expect(inserts(client)).toHaveLength(0);
      });

      it("rejects the second of two sequential refunds once it crosses the total", async () => {
        const { rows, client } = refundsStore(1000, []);

        const first = await refundCents(700);
        expect(first.status).toBe(200);
        expect(mockedRefundProcessor).toHaveBeenCalledTimes(1);

        const second = await refundCents(301);
        expect(second.status).toBe(422);
        expect(second.body).toEqual({ error: "refund exceeds order total" });
        // The processor was only called for the first refund.
        expect(mockedRefundProcessor).toHaveBeenCalledTimes(1);
        expect(inserts(client)).toHaveLength(1);
        expect(rows.map((r) => r.amount)).toEqual([700]);
      });

      it("reads the prior total inside the same transaction as the insert", async () => {
        const { client } = refundsStore(1000, [600]);
        const res = await refundCents(400);
        expect(res.status).toBe(200);
        const texts = client.query.mock.calls.map(
          ([q]: [{ text: string }]) => q.text
        );
        const sumIdx = texts.findIndex((t) => t.includes("SUM(amount)"));
        const insertIdx = texts.findIndex((t) => t.includes("INSERT INTO refunds"));
        expect(sumIdx).toBeGreaterThanOrEqual(0);
        expect(sumIdx).toBeLessThan(insertIdx);
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
