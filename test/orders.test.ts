import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { testToken } from "./helpers/token";

// `../src/db` here resolves to the same absolute file as the `../db` import
// used inside src/routes/*.ts, so this mock applies to every route under
// test regardless of how many directories separate this file from them.
vi.mock("../src/db", () => ({
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
    text: strings.join("?"),
    values,
  }),
  query: vi.fn(),
  withTransaction: vi.fn(),
}));

import { query, withTransaction } from "../src/db";
import { computeDiscount } from "../src/coupons";
import { buildApp } from "./helpers/app";

const mockedQuery = query as unknown as ReturnType<typeof vi.fn>;
const mockedWithTransaction = withTransaction as unknown as ReturnType<typeof vi.fn>;

// Transaction-local client handed to the `withTransaction` callback.
const txQuery = vi.fn();

describe("orders routes", () => {
  const app = buildApp();
  const token = testToken("user-1");

  beforeEach(() => {
    mockedQuery.mockReset();
    txQuery.mockReset();
    mockedWithTransaction.mockReset();
    mockedWithTransaction.mockImplementation(async (fn: (c: unknown) => unknown) =>
      fn({ query: txQuery })
    );
  });

  it("requires authentication", async () => {
    const res = await request(app).get("/orders");
    expect(res.status).toBe(401);
  });

  it("GET /orders/:id returns 404 when no matching order exists", async () => {
    mockedQuery.mockResolvedValueOnce([]);
    const res = await request(app)
      .get("/orders/does-not-exist")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
  });

  it("GET /orders/:id returns the order when found", async () => {
    const order = {
      id: "order-1",
      customerId: "user-1",
      total: 1999,
      items: [],
      status: "pending",
      reference: "ord_abc",
      createdAt: new Date().toISOString(),
    };
    mockedQuery.mockResolvedValueOnce([order]);
    const res = await request(app)
      .get("/orders/order-1")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: "order-1", total: 1999 });
  });

  it("GET /orders lists the authenticated customer's orders", async () => {
    mockedQuery.mockResolvedValueOnce([
      { id: "order-1", customerId: "user-1", total: 1000 },
      { id: "order-2", customerId: "user-1", total: 2000 },
    ]);
    const res = await request(app)
      .get("/orders")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
  });

  it("POST /orders creates a pending order and returns 201", async () => {
    const items = [{ sku: "sku-1", quantity: 2, unitPrice: 500 }];
    mockedQuery.mockResolvedValueOnce([
      {
        id: "order-new",
        customerId: "user-1",
        total: 1000,
        items,
        status: "pending",
        reference: "ord_new",
        createdAt: new Date().toISOString(),
      },
    ]);
    const res = await request(app)
      .post("/orders")
      .set("Authorization", `Bearer ${token}`)
      .send({ total: 1000, items });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: "order-new", status: "pending" });
  });

  describe("POST /orders with couponCode", () => {
    const items = [{ sku: "sku-1", quantity: 1, unitPrice: 1999 }];

    const post = (body: Record<string, unknown>) =>
      request(app).post("/orders").set("Authorization", `Bearer ${token}`).send(body);

    // Echo the INSERT's bound values back as the created row.
    const insertEcho = (q: { values: unknown[] }) => [
      {
        id: "order-c",
        customerId: q.values[0],
        total: q.values[1],
        reference: q.values[3],
        status: "pending",
        couponCode: q.values[4],
        discount: q.values[5],
      },
    ];

    it("rejects an unknown coupon with 422", async () => {
      txQuery.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
      const res = await post({ total: 1999, items, couponCode: "NOPE" });
      expect(res.status).toBe(422);
      expect(res.body).toEqual({ error: "coupon code not found" });
      expect(txQuery).toHaveBeenCalledTimes(2);
      expect(mockedQuery).not.toHaveBeenCalled();
    });

    it("rejects an expired coupon with 422", async () => {
      txQuery.mockResolvedValueOnce([]).mockResolvedValueOnce([
        { code: "OLD", percent_off: 10, expires_at: "2000-01-01", max_uses: 5, uses: 0, expired: true },
      ]);
      const res = await post({ total: 1999, items, couponCode: "OLD" });
      expect(res.status).toBe(422);
      expect(res.body).toEqual({ error: "coupon has expired" });
    });

    it("rejects an exhausted coupon with 422", async () => {
      txQuery.mockResolvedValueOnce([]).mockResolvedValueOnce([
        { code: "USED", percent_off: 10, expires_at: null, max_uses: 3, uses: 3, expired: false },
      ]);
      const res = await post({ total: 1999, items, couponCode: "USED" });
      expect(res.status).toBe(422);
      expect(res.body).toEqual({
        error: "coupon has reached its maximum number of uses",
      });
    });

    it("never inserts an order when the coupon is rejected", async () => {
      txQuery.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
      await post({ total: 1999, items, couponCode: "NOPE" });
      const texts = txQuery.mock.calls.map(([q]) => q.text as string);
      expect(texts.some((t) => t.includes("INSERT INTO orders"))).toBe(false);
    });

    it("rounds the discount half up in integer cents", async () => {
      // 15% of 1999 = 299.85 -> 300; 10% of 1995 = 199.5 -> 200;
      // 10% of 1994 = 199.4 -> 199; 100% of 1999 = 1999.
      expect(computeDiscount(1999, 15)).toBe(300);
      expect(computeDiscount(1995, 10)).toBe(200);
      expect(computeDiscount(1994, 10)).toBe(199);
      expect(computeDiscount(1999, 100)).toBe(1999);
      expect(computeDiscount(1, 50)).toBe(1);
      expect(computeDiscount(1, 49)).toBe(0);

      txQuery
        .mockResolvedValueOnce([{ percent_off: 10 }])
        .mockImplementationOnce(async (q) => insertEcho(q));
      const res = await post({ total: 1995, items, couponCode: "TEN" });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ total: 1795, couponCode: "TEN", discount: 200 });
    });

    it("increments uses in the same transaction as the order insert", async () => {
      txQuery
        .mockResolvedValueOnce([{ percent_off: 25 }])
        .mockImplementationOnce(async (q) => insertEcho(q));
      const res = await post({ total: 1000, items, couponCode: "QUARTER" });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ total: 750, discount: 250 });

      expect(mockedWithTransaction).toHaveBeenCalledTimes(1);
      expect(mockedQuery).not.toHaveBeenCalled();
      const [redeem, insert] = txQuery.mock.calls.map(([q]) => q);
      // Single conditional UPDATE: the max_uses/expiry guard and the increment
      // are one statement, so concurrent redemptions cannot overshoot.
      expect(redeem.text).toMatch(/UPDATE coupons SET uses = uses \+ 1/);
      expect(redeem.text).toMatch(/uses < max_uses/);
      expect(redeem.text).toMatch(/expires_at > now\(\)/);
      expect(redeem.values).toEqual(["QUARTER"]);
      expect(insert.text).toMatch(/INSERT INTO orders/);
      expect(insert.values).toContain("QUARTER");
    });

    it("stops redeeming once max_uses is reached", async () => {
      // In-memory stand-in honouring the conditional UPDATE's semantics.
      const coupon = { percent_off: 10, max_uses: 2, uses: 0 };
      txQuery.mockImplementation(async (q: { text: string; values: unknown[] }) => {
        if (q.text.startsWith("UPDATE coupons")) {
          if (coupon.uses >= coupon.max_uses) return [];
          coupon.uses += 1;
          return [{ percent_off: coupon.percent_off }];
        }
        if (q.text.startsWith("SELECT")) {
          return [{ code: "TWO", ...coupon, expires_at: null, expired: false }];
        }
        return insertEcho(q);
      });

      const statuses = [];
      for (let i = 0; i < 3; i++) {
        statuses.push((await post({ total: 1000, items, couponCode: "TWO" })).status);
      }
      expect(statuses).toEqual([201, 201, 422]);
      expect(coupon.uses).toBe(2);
    });

    it("rejects a non-integer total when a coupon is supplied", async () => {
      const res = await post({ total: 19.99, items, couponCode: "TEN" });
      expect(res.status).toBe(400);
      expect(mockedWithTransaction).not.toHaveBeenCalled();
    });
  });
});
