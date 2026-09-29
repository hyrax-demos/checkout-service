import { describe, it, expect, vi, afterEach } from "vitest";
import { chargeIdempotencyKey } from "../src/utils/tokens";

describe("chargeIdempotencyKey", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns the same key for the same order at different times", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));
    const first = chargeIdempotencyKey("order-1");
    vi.setSystemTime(new Date("2024-06-15T12:34:56Z"));
    const second = chargeIdempotencyKey("order-1");
    vi.advanceTimersByTime(60_000);
    const third = chargeIdempotencyKey("order-1");
    expect(second).toBe(first);
    expect(third).toBe(first);
  });

  it("returns different keys for different orders", () => {
    expect(chargeIdempotencyKey("order-1")).not.toBe(
      chargeIdempotencyKey("order-2")
    );
  });

  it("includes the order id in the key", () => {
    expect(chargeIdempotencyKey("order-42")).toContain("order-42");
  });
});

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

describe("POST /payments/charge idempotency", () => {
  it("sends the same idempotency key when the charge is retried later", async () => {
    const request = (await import("supertest")).default;
    const { testToken } = await import("./helpers/token");
    const { query } = await import("../src/db");
    const { chargeProcessor } = await import("../src/processor");
    const { buildApp } = await import("./helpers/app");
    const mockedQuery = query as unknown as ReturnType<typeof vi.fn>;
    const mockedCharge = chargeProcessor as unknown as ReturnType<typeof vi.fn>;
    const app = buildApp();
    const token = testToken("user-1");

    const attempt = async () => {
      mockedQuery.mockResolvedValueOnce([
        { id: "order-1", total: 1999, status: "pending" },
      ]);
      mockedQuery.mockResolvedValueOnce([]);
      const res = await request(app)
        .post("/payments/charge")
        .set("Authorization", `Bearer ${token}`)
        .send({ orderId: "order-1" });
      expect(res.status).toBe(200);
    };

    const realNow = Date.now;
    try {
      Date.now = () => 1_700_000_000_000;
      await attempt();
      Date.now = () => 1_700_000_999_999;
      await attempt();
    } finally {
      Date.now = realNow;
    }

    expect(mockedCharge).toHaveBeenCalledTimes(2);
    const [firstKey, secondKey] = mockedCharge.mock.calls.map(
      (c) => c[0].idempotencyKey
    );
    expect(secondKey).toBe(firstKey);
    expect(firstKey).toBe(chargeIdempotencyKey("order-1"));
  });
});
