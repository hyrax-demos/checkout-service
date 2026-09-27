import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { testToken } from "./helpers/token";

// `src/config` reads REFUND_MAX_CENTS once at import time, and ESM import
// hoisting means a top-level `import` always executes before any top-level
// statement in this file, however it's ordered on the page. So the env var
// is set here, and everything that (transitively) depends on `../src/config`
// is loaded via a dynamic `import()` inside `beforeAll`, after it's set.
const previousRefundMaxCents = process.env.REFUND_MAX_CENTS;
process.env.REFUND_MAX_CENTS = "2500"; // $25.00

afterAll(() => {
  if (previousRefundMaxCents === undefined) {
    delete process.env.REFUND_MAX_CENTS;
  } else {
    process.env.REFUND_MAX_CENTS = previousRefundMaxCents;
  }
});

vi.mock("../src/db", () => ({
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
    text: strings.join("?"),
    values,
  }),
  query: vi.fn(),
  withTransaction: vi.fn(),
}));

let mockedQuery: ReturnType<typeof vi.fn>;
let mockedWithTransaction: ReturnType<typeof vi.fn>;
let app: ReturnType<typeof import("./helpers/app").buildApp>;

beforeAll(async () => {
  const { query, withTransaction } = await import("../src/db");
  const { buildApp } = await import("./helpers/app");
  mockedQuery = query as unknown as ReturnType<typeof vi.fn>;
  mockedWithTransaction = withTransaction as unknown as ReturnType<
    typeof vi.fn
  >;
  app = buildApp();
});

function fakeTransaction() {
  const client = { query: vi.fn().mockResolvedValue([]) };
  mockedWithTransaction.mockImplementationOnce(async (fn: any) => fn(client));
  return client;
}

describe("POST /refunds with a configured REFUND_MAX_CENTS", () => {
  const token = testToken("user-1");

  beforeEach(() => {
    mockedQuery.mockReset();
    mockedWithTransaction.mockReset();
  });

  it("rejects a refund above the configured ceiling before touching the processor/db", async () => {
    mockedQuery.mockResolvedValueOnce([
      { id: "order-1", total: 10000, status: "paid" },
    ]);
    const res = await request(app)
      .post("/refunds")
      .set("Authorization", `Bearer ${token}`)
      .send({ reference: "ord_abc", amountDollars: 25.01 });
    expect(res.status).toBe(422);
    expect(mockedWithTransaction).not.toHaveBeenCalled();
  });

  it("allows a refund exactly at the configured ceiling", async () => {
    mockedQuery.mockImplementation(async (q: { text: string }) => {
      if (q.text.includes("FROM orders")) {
        return [{ id: "order-1", total: 10000, status: "paid" }];
      }
      return [];
    });
    fakeTransaction();
    const res = await request(app)
      .post("/refunds")
      .set("Authorization", `Bearer ${token}`)
      .send({ reference: "ord_abc", amountDollars: 25 });
    expect(res.status).toBe(200);
    expect(res.body.amount).toBe(2500);
  });

  it("still applies the order-total limit when it is lower than the configured ceiling", async () => {
    mockedQuery.mockResolvedValueOnce([
      { id: "order-1", total: 1000, status: "paid" },
    ]);
    const res = await request(app)
      .post("/refunds")
      .set("Authorization", `Bearer ${token}`)
      .send({ reference: "ord_abc", amountDollars: 15 });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe("refund exceeds order total");
    expect(mockedWithTransaction).not.toHaveBeenCalled();
  });
});
