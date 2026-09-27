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

vi.mock("../src/processor", () => ({
  ProcessorError: class ProcessorError extends Error {},
  chargeProcessor: vi.fn().mockResolvedValue(undefined),
  refundProcessor: vi.fn().mockResolvedValue(undefined),
}));

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

describe("POST /refunds -> refundProcessor", () => {
  const app = buildApp();
  const token = testToken("user-1");

  beforeEach(() => {
    mockedQuery.mockReset();
    mockedWithTransaction.mockReset();
    mockedRefundProcessor.mockClear();
    mockedQuery.mockImplementation(async (q: { text: string }) => {
      if (q.text.includes("FROM orders")) {
        return [{ id: "order-1", total: 1999, status: "paid" }];
      }
      return [];
    });
    const client = { query: vi.fn().mockResolvedValue([]) };
    mockedWithTransaction.mockImplementation(async (fn: any) => fn(client));
  });

  it.each([
    [19.99, 1999],
    [5, 500],
    [0.29, 29],
    [10.1, 1010],
  ])(
    "passes %s dollars to the processor as %s integer cents",
    async (amountDollars, expectedCents) => {
      const res = await request(app)
        .post("/refunds")
        .set("Authorization", `Bearer ${token}`)
        .send({ reference: "ord_abc", amountDollars });
      expect(res.status).toBe(200);
      expect(mockedRefundProcessor).toHaveBeenCalledTimes(1);
      const args = mockedRefundProcessor.mock.calls[0][0];
      expect(args.amount).toBe(expectedCents);
      expect(Number.isInteger(args.amount)).toBe(true);
      expect(args.orderId).toBe("order-1");
      // Processor amount must agree with the amount reported to the caller.
      expect(res.body.amount).toBe(args.amount);
    }
  );

  it("does not call the processor when the refund exceeds the order total", async () => {
    const res = await request(app)
      .post("/refunds")
      .set("Authorization", `Bearer ${token}`)
      .send({ reference: "ord_abc", amountDollars: 20 });
    expect(res.status).toBe(422);
    expect(mockedRefundProcessor).not.toHaveBeenCalled();
  });
});
