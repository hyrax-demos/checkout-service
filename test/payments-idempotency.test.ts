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

vi.mock("../src/processor", () => ({
  ProcessorError: class ProcessorError extends Error {},
  chargeProcessor: vi.fn().mockResolvedValue(undefined),
  refundProcessor: vi.fn().mockResolvedValue(undefined),
}));

import { query } from "../src/db";
import { chargeProcessor } from "../src/processor";
import { buildApp } from "./helpers/app";

const mockedQuery = query as unknown as ReturnType<typeof vi.fn>;
const mockedCharge = chargeProcessor as unknown as ReturnType<typeof vi.fn>;

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

  function pendingOrders(...ids: string[]) {
    mockedQuery.mockImplementation(async (q: { text: string }) => {
      if (q.text.startsWith("SELECT")) {
        return ids.map((id) => ({ id, total: 1000, status: "pending" }));
      }
      return [];
    });
  }

  it("reuses the same key when a charge for the same order is retried later", async () => {
    pendingOrders("order-1");

    vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));
    await request(app)
      .post("/payments/charge")
      .set("Authorization", `Bearer ${token}`)
      .send({ orderId: "order-1" })
      .expect(200);

    vi.setSystemTime(new Date("2024-01-01T00:05:00Z"));
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

  it("uses the same key for an order in the batch capture as in a single charge", async () => {
    pendingOrders("order-1");
    vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));
    await request(app)
      .post("/payments/charge")
      .set("Authorization", `Bearer ${token}`)
      .send({ orderId: "order-1" })
      .expect(200);

    vi.setSystemTime(new Date("2024-01-02T00:00:00Z"));
    await request(app)
      .post("/payments/capture-batch")
      .set("Authorization", `Bearer ${token}`)
      .send({ orderIds: ["order-1"] })
      .expect(200);

    const [single, batch] = mockedCharge.mock.calls.map(
      (c) => c[0].idempotencyKey
    );
    expect(batch).toBe(single);
  });

  it("uses distinct keys for distinct orders in a batch capture", async () => {
    pendingOrders("order-1", "order-2");
    await request(app)
      .post("/payments/capture-batch")
      .set("Authorization", `Bearer ${token}`)
      .send({ orderIds: ["order-1", "order-2"] })
      .expect(200);

    const keys = mockedCharge.mock.calls.map((c) => c[0].idempotencyKey);
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
  });
});
