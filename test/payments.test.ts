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
import * as processor from "../src/processor";
import {
  config,
  parseRefundMaxCents,
  DEFAULT_REFUND_MAX_CENTS,
} from "../src/config";

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

    describe("platform-wide refund ceiling", () => {
      const originalMax = config.refundMaxCents;

      function orderWithTotal(total: number) {
        mockedQuery.mockImplementation(async (q: { text: string }) => {
          if (q.text.includes("FROM orders")) {
            return [{ id: "order-1", total, status: "paid" }];
          }
          return [];
        });
      }

      beforeEach(() => {
        config.refundMaxCents = originalMax;
      });

      afterEach(() => {
        config.refundMaxCents = originalMax;
        vi.restoreAllMocks();
      });

      it("defaults to 50000 cents when REFUND_MAX_CENTS is unset", () => {
        expect(DEFAULT_REFUND_MAX_CENTS).toBe(50000);
        if (process.env.REFUND_MAX_CENTS === undefined) {
          expect(config.refundMaxCents).toBe(50000);
        }
      });

      it("rejects a refund above the ceiling with 422 before calling the processor or writing", async () => {
        config.refundMaxCents = 50000;
        const spy = vi.spyOn(processor, "refundProcessor");
        orderWithTotal(100000);
        const res = await request(app)
          .post("/refunds")
          .set("Authorization", `Bearer ${token}`)
          .send({ reference: "ord_abc", amountDollars: 500.01 });
        expect(res.status).toBe(422);
        expect(spy).not.toHaveBeenCalled();
        expect(mockedWithTransaction).not.toHaveBeenCalled();
        // Only the order lookup ran; nothing was written.
        for (const call of mockedQuery.mock.calls) {
          expect(call[0].text).not.toMatch(/INSERT|UPDATE/);
        }
      });

      it("allows a refund exactly at the ceiling", async () => {
        config.refundMaxCents = 50000;
        const spy = vi.spyOn(processor, "refundProcessor");
        orderWithTotal(100000);
        fakeTransaction();
        const res = await request(app)
          .post("/refunds")
          .set("Authorization", `Bearer ${token}`)
          .send({ reference: "ord_abc", amountDollars: 500 });
        expect(res.status).toBe(200);
        expect(res.body.amount).toBe(50000);
        expect(spy).toHaveBeenCalledTimes(1);
      });

      it("honours a configured ceiling", async () => {
        config.refundMaxCents = 1000;
        orderWithTotal(5000);
        const res = await request(app)
          .post("/refunds")
          .set("Authorization", `Bearer ${token}`)
          .send({ reference: "ord_abc", amountDollars: 10.01 });
        expect(res.status).toBe(422);
        expect(mockedWithTransaction).not.toHaveBeenCalled();
      });

      it("keeps the order total as the binding limit when it is below the ceiling", async () => {
        config.refundMaxCents = 10_000_000;
        const spy = vi.spyOn(processor, "refundProcessor");
        orderWithTotal(1999);
        const res = await request(app)
          .post("/refunds")
          .set("Authorization", `Bearer ${token}`)
          .send({ reference: "ord_abc", amountDollars: 20 });
        expect(res.status).toBe(422);
        expect(spy).not.toHaveBeenCalled();
        expect(mockedWithTransaction).not.toHaveBeenCalled();
      });

      it("still returns 400/404/409 for the existing validation cases", async () => {
        config.refundMaxCents = 1;
        let res = await request(app)
          .post("/refunds")
          .set("Authorization", `Bearer ${token}`)
          .send({ reference: "ord_abc", amountDollars: -1 });
        expect(res.status).toBe(400);

        mockedQuery.mockResolvedValueOnce([]);
        res = await request(app)
          .post("/refunds")
          .set("Authorization", `Bearer ${token}`)
          .send({ reference: "ord_missing", amountDollars: 1000 });
        expect(res.status).toBe(404);

        mockedQuery.mockResolvedValueOnce([
          { id: "order-1", total: 100000, status: "cancelled" },
        ]);
        res = await request(app)
          .post("/refunds")
          .set("Authorization", `Bearer ${token}`)
          .send({ reference: "ord_abc", amountDollars: 1000 });
        expect(res.status).toBe(409);
      });
    });

    describe("parseRefundMaxCents", () => {
      it("defaults when unset or empty", () => {
        expect(parseRefundMaxCents(undefined)).toBe(50000);
        expect(parseRefundMaxCents("")).toBe(50000);
        expect(parseRefundMaxCents("   ")).toBe(50000);
      });

      it("parses an integer number of cents", () => {
        expect(parseRefundMaxCents("125000")).toBe(125000);
        expect(parseRefundMaxCents(" 0 ")).toBe(0);
      });

      it("rejects malformed values", () => {
        for (const bad of ["abc", "12.5", "-100", "1e5", "500 dollars"]) {
          expect(() => parseRefundMaxCents(bad)).toThrow(/REFUND_MAX_CENTS/);
        }
        expect(() => parseRefundMaxCents("99999999999999999999")).toThrow(
          /REFUND_MAX_CENTS/
        );
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
