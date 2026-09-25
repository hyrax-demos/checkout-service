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

function fakeTransaction() {
  const client = { query: vi.fn().mockResolvedValue([]) };
  mockedWithTransaction.mockImplementationOnce(async (fn: any) => fn(client));
  return client;
}

function paidOrder(total: number) {
  mockedQuery.mockImplementation(async (q: { text: string }) => {
    if (q.text.includes("FROM orders")) {
      return [{ id: "order-1", total, status: "paid" }];
    }
    return [];
  });
}

describe("POST /refunds processor amount", () => {
  const app = buildApp();
  const token = testToken("user-1");

  beforeEach(() => {
    mockedQuery.mockReset();
    mockedWithTransaction.mockReset();
    mockedRefundProcessor.mockReset();
    mockedRefundProcessor.mockResolvedValue(undefined);
  });

  it("passes the refund amount to the processor in integer cents", async () => {
    paidOrder(1999);
    fakeTransaction();
    const res = await request(app)
      .post("/refunds")
      .set("Authorization", `Bearer ${token}`)
      .send({ reference: "ord_abc", amountDollars: 19.99 });

    expect(res.status).toBe(200);
    expect(mockedRefundProcessor).toHaveBeenCalledTimes(1);
    const args = mockedRefundProcessor.mock.calls[0][0];
    expect(args.orderId).toBe("order-1");
    expect(args.amount).toBe(1999);
    expect(Number.isInteger(args.amount)).toBe(true);
  });

  it("sends the processor the same cents value it records and returns", async () => {
    paidOrder(5000);
    const client = fakeTransaction();
    const res = await request(app)
      .post("/refunds")
      .set("Authorization", `Bearer ${token}`)
      .send({ reference: "ord_abc", amountDollars: 12.5 });

    expect(res.status).toBe(200);
    expect(res.body.amount).toBe(1250);
    expect(mockedRefundProcessor.mock.calls[0][0].amount).toBe(1250);

    const insert = client.query.mock.calls
      .map((c: any[]) => c[0])
      .find((q: { text: string }) => q.text.includes("INSERT INTO refunds"));
    expect(insert).toBeDefined();
    expect(insert.values).toContain(1250);
  });

  it("rounds fractional-cent float artefacts before calling the processor", async () => {
    paidOrder(1000);
    fakeTransaction();
    const res = await request(app)
      .post("/refunds")
      .set("Authorization", `Bearer ${token}`)
      // 0.1 + 0.2 style float: 0.29 * 100 === 28.999999999999996
      .send({ reference: "ord_abc", amountDollars: 0.29 });

    expect(res.status).toBe(200);
    expect(mockedRefundProcessor.mock.calls[0][0].amount).toBe(29);
  });

  it("does not call the processor when the refund exceeds the order total", async () => {
    paidOrder(1000);
    const res = await request(app)
      .post("/refunds")
      .set("Authorization", `Bearer ${token}`)
      .send({ reference: "ord_abc", amountDollars: 10.01 });

    expect(res.status).toBe(422);
    expect(mockedRefundProcessor).not.toHaveBeenCalled();
  });
});
