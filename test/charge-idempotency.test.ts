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
  return {
    ...actual,
    chargeProcessor: vi.fn().mockResolvedValue(undefined),
  };
});

import { query } from "../src/db";
import { chargeProcessor } from "../src/processor";
import { buildApp } from "./helpers/app";

const mockedQuery = query as unknown as ReturnType<typeof vi.fn>;
const mockedCharge = chargeProcessor as unknown as ReturnType<typeof vi.fn>;

function pendingOrder(id: string) {
  mockedQuery.mockResolvedValueOnce([{ id, total: 1999, status: "pending" }]);
  mockedQuery.mockResolvedValueOnce([]);
}

describe("charge idempotency key sent to the processor", () => {
  const app = buildApp();
  const token = testToken("user-1");

  beforeEach(() => {
    mockedQuery.mockReset();
    mockedCharge.mockClear();
    vi.useFakeTimers({ toFake: ["Date"] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses the same key when a charge for the same order is retried later", async () => {
    vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));
    pendingOrder("order-1");
    await request(app)
      .post("/payments/charge")
      .set("Authorization", `Bearer ${token}`)
      .send({ orderId: "order-1" })
      .expect(200);

    vi.setSystemTime(new Date("2024-01-01T00:05:00Z"));
    pendingOrder("order-1");
    await request(app)
      .post("/payments/charge")
      .set("Authorization", `Bearer ${token}`)
      .send({ orderId: "order-1" })
      .expect(200);

    expect(mockedCharge).toHaveBeenCalledTimes(2);
    const [first, retry] = mockedCharge.mock.calls.map(
      (c) => c[0].idempotencyKey
    );
    expect(retry).toBe(first);
  });

  it("uses different keys for different orders", async () => {
    pendingOrder("order-1");
    await request(app)
      .post("/payments/charge")
      .set("Authorization", `Bearer ${token}`)
      .send({ orderId: "order-1" })
      .expect(200);

    pendingOrder("order-2");
    await request(app)
      .post("/payments/charge")
      .set("Authorization", `Bearer ${token}`)
      .send({ orderId: "order-2" })
      .expect(200);

    const [a, b] = mockedCharge.mock.calls.map((c) => c[0].idempotencyKey);
    expect(a).not.toBe(b);
  });
});
