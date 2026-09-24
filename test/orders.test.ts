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
});
