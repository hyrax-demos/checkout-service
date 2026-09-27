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

import { query } from "../src/db";
import { buildApp } from "./helpers/app";

const mockedQuery = query as unknown as ReturnType<typeof vi.fn>;

describe("orders routes", () => {
  const app = buildApp();
  const token = testToken("user-1");

  beforeEach(() => {
    mockedQuery.mockReset();
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

  describe("POST /orders input validation", () => {
    const validItems = [{ sku: "sku-1", quantity: 1, unitPrice: 500 }];

    const invalidBodies: Array<[string, Record<string, unknown>]> = [
      ["items is missing", { total: 500 }],
      ["items is empty", { total: 500, items: [] }],
      ["items is not an array", { total: 500, items: { sku: "sku-1" } }],
      ["items is a string", { total: 500, items: "sku-1" }],
      ["total is missing", { items: validItems }],
      ["total is zero", { total: 0, items: validItems }],
      ["total is negative", { total: -100, items: validItems }],
      ["total is fractional", { total: 10.5, items: validItems }],
      ["total is a numeric string", { total: "500", items: validItems }],
      ["total is null", { total: null, items: validItems }],
    ];

    it.each(invalidBodies)("returns 400 when %s", async (_label, body) => {
      const res = await request(app)
        .post("/orders")
        .set("Authorization", `Bearer ${token}`)
        .send(body);
      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty("error");
      expect(mockedQuery).not.toHaveBeenCalled();
    });

    it("returns 400 when the body is empty", async () => {
      const res = await request(app)
        .post("/orders")
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(400);
      expect(mockedQuery).not.toHaveBeenCalled();
    });

    it.each([
      ["items is missing", { total: 500 }],
      ["items is empty", { total: 500, items: [] }],
      ["items is not an array", { total: 500, items: { sku: "sku-1" } }],
    ])("keeps the items error message when %s", async (_label, body) => {
      const res = await request(app)
        .post("/orders")
        .set("Authorization", `Bearer ${token}`)
        .send(body);
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: "items must be a non-empty array" });
    });

    it.each([
      ["total is missing", { items: validItems }],
      ["total is zero", { total: 0, items: validItems }],
      ["total is fractional", { total: 10.5, items: validItems }],
      ["total is a numeric string", { total: "500", items: validItems }],
    ])("keeps the total error message when %s", async (_label, body) => {
      const res = await request(app)
        .post("/orders")
        .set("Authorization", `Bearer ${token}`)
        .send(body);
      expect(res.status).toBe(400);
      expect(res.body).toEqual({
        error: "total must be a positive integer number of cents",
      });
    });

    it("accepts the smallest positive total", async () => {
      mockedQuery.mockResolvedValueOnce([
        { id: "order-min", total: 1, items: validItems, status: "pending" },
      ]);
      const res = await request(app)
        .post("/orders")
        .set("Authorization", `Bearer ${token}`)
        .send({ total: 1, items: validItems });
      expect(res.status).toBe(201);
      expect(mockedQuery).toHaveBeenCalledTimes(1);
    });
  });
});
