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

import { query, withTransaction } from "../src/db";
import { buildApp } from "./helpers/app";
import * as processor from "../src/processor";

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

// After the initial order lookup, answer the capture-batch claim
// (`UPDATE ... status = 'pending' RETURNING id`) as won by returning the
// claimed row, and every other statement with no rows.
function claimSucceeds() {
  mockedQuery.mockImplementation(async (q: { text: string; values: unknown[] }) =>
    q.text.includes("RETURNING id") ? [{ id: q.values[0] }] : []
  );
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

    it.each([
      ["zero", 0],
      ["negative", -5],
      ["a numeric string", "5"],
      ["missing", undefined],
    ])("keeps the amount error message when amountDollars is %s", async (_label, amountDollars) => {
      const res = await request(app)
        .post("/refunds")
        .set("Authorization", `Bearer ${token}`)
        .send({ reference: "ord_abc", amountDollars });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: "amountDollars must be a positive number" });
      expect(mockedQuery).not.toHaveBeenCalled();
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
  });

  describe("POST /payments/capture-batch", () => {
    it("rejects an empty orderIds array", async () => {
      const res = await request(app)
        .post("/payments/capture-batch")
        .set("Authorization", `Bearer ${token}`)
        .send({ orderIds: [] });
      expect(res.status).toBe(400);
    });

    it.each([
      ["empty", []],
      ["missing", undefined],
      ["not an array", "order-1"],
      ["an array with a non-string id", ["order-1", 42]],
    ])("keeps the orderIds error message when orderIds is %s", async (_label, orderIds) => {
      const res = await request(app)
        .post("/payments/capture-batch")
        .set("Authorization", `Bearer ${token}`)
        .send({ orderIds });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: "orderIds must be a non-empty array" });
      expect(mockedQuery).not.toHaveBeenCalled();
    });

    it("captures every matching order", async () => {
      mockedQuery.mockResolvedValueOnce([
        { id: "order-1", total: 500, status: "pending" },
        { id: "order-2", total: 700, status: "pending" },
      ]);
      claimSucceeds();
      const res = await request(app)
        .post("/payments/capture-batch")
        .set("Authorization", `Bearer ${token}`)
        .send({ orderIds: ["order-1", "order-2"] });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.captured.sort()).toEqual(["order-1", "order-2"]);
      expect(res.body.skipped).toEqual([]);
    });

    it("only charges pending orders and reports the rest as skipped", async () => {
      mockedQuery.mockResolvedValueOnce([
        { id: "order-1", total: 500, status: "pending" },
        { id: "order-2", total: 700, status: "paid" },
        { id: "order-3", total: 900, status: "cancelled" },
        { id: "order-4", total: 1100, status: "refunded" },
      ]);
      claimSucceeds();
      const chargeSpy = vi.spyOn(processor, "chargeProcessor");
      const res = await request(app)
        .post("/payments/capture-batch")
        .set("Authorization", `Bearer ${token}`)
        .send({ orderIds: ["order-1", "order-2", "order-3", "order-4"] });
      expect(res.status).toBe(200);
      expect(res.body.captured).toEqual(["order-1"]);
      expect(res.body.skipped.sort()).toEqual(["order-2", "order-3", "order-4"]);
      expect(chargeSpy).toHaveBeenCalledTimes(1);
      expect(chargeSpy.mock.calls[0][0].amount).toBe(500);
      // Lookup + a single status update for the one pending order.
      expect(mockedQuery).toHaveBeenCalledTimes(2);
      chargeSpy.mockRestore();
    });

    it("skips requested ids that were not found for the caller", async () => {
      mockedQuery.mockResolvedValueOnce([
        { id: "order-1", total: 500, status: "pending" },
      ]);
      claimSucceeds();
      const res = await request(app)
        .post("/payments/capture-batch")
        .set("Authorization", `Bearer ${token}`)
        .send({ orderIds: ["order-1", "order-missing"] });
      expect(res.status).toBe(200);
      expect(res.body.captured).toEqual(["order-1"]);
      expect(res.body.skipped).toEqual(["order-missing"]);
    });

    it("charges nothing when no requested order is pending", async () => {
      mockedQuery.mockResolvedValueOnce([
        { id: "order-2", total: 700, status: "paid" },
      ]);
      const chargeSpy = vi.spyOn(processor, "chargeProcessor");
      const res = await request(app)
        .post("/payments/capture-batch")
        .set("Authorization", `Bearer ${token}`)
        .send({ orderIds: ["order-2"] });
      expect(res.status).toBe(200);
      expect(res.body.captured).toEqual([]);
      expect(res.body.skipped).toEqual(["order-2"]);
      expect(chargeSpy).not.toHaveBeenCalled();
      expect(mockedQuery).toHaveBeenCalledTimes(1);
      chargeSpy.mockRestore();
    });

    it("does not charge an order another request moved out of pending first", async () => {
      // The lookup still sees `pending`, but by the time the claim runs a
      // concurrent capture has already flipped the order, so the guarded
      // update matches no rows.
      mockedQuery.mockResolvedValueOnce([
        { id: "order-1", total: 500, status: "pending" },
      ]);
      mockedQuery.mockResolvedValue([]);
      const chargeSpy = vi.spyOn(processor, "chargeProcessor");
      const res = await request(app)
        .post("/payments/capture-batch")
        .set("Authorization", `Bearer ${token}`)
        .send({ orderIds: ["order-1"] });
      expect(res.status).toBe(200);
      expect(res.body.captured).toEqual([]);
      expect(res.body.skipped).toEqual(["order-1"]);
      expect(chargeSpy).not.toHaveBeenCalled();
      const claim = mockedQuery.mock.calls[1][0] as { text: string };
      expect(claim.text).toContain("status = 'pending'");
      chargeSpy.mockRestore();
    });

    it("releases the claim when the processor rejects the capture", async () => {
      mockedQuery.mockResolvedValueOnce([
        { id: "order-1", total: 500, status: "pending" },
      ]);
      claimSucceeds();
      const chargeSpy = vi
        .spyOn(processor, "chargeProcessor")
        .mockRejectedValueOnce(new processor.ProcessorError("declined"));
      const res = await request(app)
        .post("/payments/capture-batch")
        .set("Authorization", `Bearer ${token}`)
        .send({ orderIds: ["order-1"] });
      expect(res.status).toBe(200);
      expect(res.body.captured).toEqual([]);
      // Lookup, claim, then the revert back to pending.
      expect(mockedQuery).toHaveBeenCalledTimes(3);
      const revert = mockedQuery.mock.calls[2][0] as { text: string };
      expect(revert.text).toContain("SET status = 'pending'");
      chargeSpy.mockRestore();
    });
  });
});
