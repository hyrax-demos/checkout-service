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
  return { ...actual, chargeProcessor: vi.fn().mockResolvedValue(undefined) };
});

import { query } from "../src/db";
import { chargeProcessor } from "../src/processor";
import { buildApp } from "./helpers/app";

const mockedQuery = query as unknown as ReturnType<typeof vi.fn>;
const mockedCharge = chargeProcessor as unknown as ReturnType<typeof vi.fn>;

function sentKeys(): string[] {
  return mockedCharge.mock.calls.map(
    (call) => (call[0] as { idempotencyKey: string }).idempotencyKey
  );
}

describe("charge idempotency keys sent to the processor", () => {
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

  async function chargeOnce(orderId: string) {
    mockedQuery.mockResolvedValueOnce([
      { id: orderId, total: 1999, status: "pending" },
    ]);
    mockedQuery.mockResolvedValueOnce([]);
    return request(app)
      .post("/payments/charge")
      .set("Authorization", `Bearer ${token}`)
      .send({ orderId });
  }

  it("reuses the same key when a charge for the same order is retried later", async () => {
    vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));
    expect((await chargeOnce("order-1")).status).toBe(200);

    vi.setSystemTime(new Date("2024-01-01T00:10:00Z"));
    expect((await chargeOnce("order-1")).status).toBe(200);

    const keys = sentKeys();
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
  });

  it("sends different keys for different orders", async () => {
    await chargeOnce("order-1");
    await chargeOnce("order-2");

    const keys = sentKeys();
    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it("uses the same key from the single-charge and batch-capture routes", async () => {
    vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));
    await chargeOnce("order-1");

    vi.setSystemTime(new Date("2024-01-01T01:00:00Z"));
    mockedQuery.mockResolvedValueOnce([
      { id: "order-1", total: 1999, status: "pending" },
    ]);
    mockedQuery.mockResolvedValue([]);
    const res = await request(app)
      .post("/payments/capture-batch")
      .set("Authorization", `Bearer ${token}`)
      .send({ orderIds: ["order-1"] });
    expect(res.status).toBe(200);

    const keys = sentKeys();
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
  });
});
