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

vi.mock("../src/processor", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/processor")>();
  return { ...actual, refundProcessor: vi.fn().mockResolvedValue(undefined) };
});

import { query, withTransaction } from "../src/db";
import { refundProcessor } from "../src/processor";
import {
  config,
  parseRefundMaxCents,
  DEFAULT_REFUND_MAX_CENTS,
} from "../src/config";
import { buildApp } from "./helpers/app";

const mockedQuery = query as unknown as ReturnType<typeof vi.fn>;
const mockedWithTransaction = withTransaction as unknown as ReturnType<
  typeof vi.fn
>;
const mockedRefundProcessor = refundProcessor as unknown as ReturnType<
  typeof vi.fn
>;

function orderWithTotal(total: number) {
  mockedQuery.mockImplementation(async (q: { text: string }) => {
    if (q.text.includes("FROM orders")) {
      return [{ id: "order-1", total, status: "paid" }];
    }
    return [];
  });
}

function fakeTransaction() {
  const client = { query: vi.fn().mockResolvedValue([]) };
  mockedWithTransaction.mockImplementation(async (fn: any) => fn(client));
  return client;
}

describe("parseRefundMaxCents", () => {
  it("defaults to 50000 when unset or empty", () => {
    expect(DEFAULT_REFUND_MAX_CENTS).toBe(50000);
    expect(parseRefundMaxCents(undefined)).toBe(50000);
    expect(parseRefundMaxCents("")).toBe(50000);
    expect(parseRefundMaxCents("   ")).toBe(50000);
  });

  it("parses an integer number of cents", () => {
    expect(parseRefundMaxCents("125000")).toBe(125000);
    expect(parseRefundMaxCents(" 100 ")).toBe(100);
    expect(parseRefundMaxCents("0")).toBe(0);
  });

  it.each(["abc", "12.5", "-1", "1e5", "500.00", "99999999999999999999"])(
    "rejects malformed value %s rather than disabling the ceiling",
    (raw) => {
      expect(() => parseRefundMaxCents(raw)).toThrow(/REFUND_MAX_CENTS/);
    }
  );

  it("uses the default in config when REFUND_MAX_CENTS is not set", () => {
    // test/setup.ts does not set REFUND_MAX_CENTS.
    expect(config.refundMaxCents).toBe(50000);
  });
});

describe("POST /refunds platform ceiling", () => {
  const app = buildApp();
  const token = testToken("user-1");
  const originalCeiling = config.refundMaxCents;

  beforeEach(() => {
    mockedQuery.mockReset();
    mockedWithTransaction.mockReset();
    mockedRefundProcessor.mockClear();
  });

  afterEach(() => {
    config.refundMaxCents = originalCeiling;
  });

  function refund(amountDollars: number) {
    return request(app)
      .post("/refunds")
      .set("Authorization", `Bearer ${token}`)
      .send({ reference: "ord_abc", amountDollars });
  }

  it("rejects a refund above the default ceiling with 422 and no side effects", async () => {
    orderWithTotal(100000);
    fakeTransaction();
    const res = await refund(500.01);
    expect(res.status).toBe(422);
    expect(mockedRefundProcessor).not.toHaveBeenCalled();
    expect(mockedWithTransaction).not.toHaveBeenCalled();
    // Only the order lookup; nothing written.
    for (const call of mockedQuery.mock.calls) {
      expect(call[0].text).not.toMatch(/INSERT|UPDATE|DELETE/i);
    }
  });

  it("allows a refund exactly at the ceiling", async () => {
    orderWithTotal(100000);
    fakeTransaction();
    const res = await refund(500);
    expect(res.status).toBe(200);
    expect(res.body.amount).toBe(50000);
    expect(mockedRefundProcessor).toHaveBeenCalledTimes(1);
  });

  it("honours a configured ceiling", async () => {
    config.refundMaxCents = 1000;
    orderWithTotal(5000);
    fakeTransaction();
    expect((await refund(10.01)).status).toBe(422);
    expect(mockedRefundProcessor).not.toHaveBeenCalled();

    fakeTransaction();
    const ok = await refund(10);
    expect(ok.status).toBe(200);
    expect(ok.body.amount).toBe(1000);
  });

  it("still enforces the order total when it is lower than a high ceiling", async () => {
    config.refundMaxCents = 10_000_000;
    orderWithTotal(1999);
    fakeTransaction();
    const res = await refund(20);
    expect(res.status).toBe(422);
    expect(res.body.error).toBe("refund exceeds order total");
    expect(mockedRefundProcessor).not.toHaveBeenCalled();
    expect(mockedWithTransaction).not.toHaveBeenCalled();
  });

  it("keeps existing validation ahead of the ceiling", async () => {
    config.refundMaxCents = 100;
    expect((await refund(0)).status).toBe(400);

    mockedQuery.mockResolvedValueOnce([]);
    expect((await refund(5)).status).toBe(404);

    mockedQuery.mockResolvedValueOnce([
      { id: "order-1", total: 1999, status: "pending" },
    ]);
    expect((await refund(5)).status).toBe(409);
    expect(mockedRefundProcessor).not.toHaveBeenCalled();
  });
});
