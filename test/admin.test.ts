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

import { query } from "../src/db";
import { buildApp } from "./helpers/app";

const mockedQuery = query as unknown as ReturnType<typeof vi.fn>;

describe("admin routes", () => {
  const app = buildApp();
  const adminToken = testToken("admin-1", "admin");
  const customerToken = testToken("user-1");

  beforeEach(() => {
    mockedQuery.mockReset();
  });

  it("rejects a non-admin caller", async () => {
    const res = await request(app)
      .post("/admin/orders/purge")
      .set("Authorization", `Bearer ${customerToken}`);
    expect(res.status).toBe(403);
  });

  it("purges cancelled orders and reports the count", async () => {
    mockedQuery.mockResolvedValueOnce([{ id: "o1" }, { id: "o2" }]);
    const res = await request(app)
      .post("/admin/orders/purge")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ purged: 2 });
  });

  it("rejects a credit with a non-numeric amount", async () => {
    const res = await request(app)
      .post("/admin/credits")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ customerId: "user-1", amount: "10" });
    expect(res.status).toBe(400);
  });

  it("issues a manual credit", async () => {
    mockedQuery.mockResolvedValueOnce([]);
    const res = await request(app)
      .post("/admin/credits")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ customerId: "user-1", amount: 500 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ credited: true });
  });
});
