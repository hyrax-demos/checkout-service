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
    const retry = chargeIdempotencyKey("order-1");

    vi.advanceTimersByTime(60_000);
    const laterRetry = chargeIdempotencyKey("order-1");

    expect(retry).toBe(first);
    expect(laterRetry).toBe(first);
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

describe("payments routes idempotency key", () => {
  it("sends the same idempotency key when a charge is retried", async () => {
    vi.resetModules();
    const calls: string[] = [];
    vi.doMock("../src/processor", async () => {
      const actual = await vi.importActual<typeof import("../src/processor")>(
        "../src/processor"
      );
      return {
        ...actual,
        chargeProcessor: vi.fn(async (args: { idempotencyKey: string }) => {
          calls.push(args.idempotencyKey);
        }),
      };
    });
    vi.doMock("../src/db", () => ({
      sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
        text: strings.join("?"),
        values,
      }),
      query: vi.fn(async (q: { text: string }) =>
        q.text.includes("SELECT")
          ? [{ id: "order-1", total: 1999, status: "pending" }]
          : []
      ),
      withTransaction: vi.fn(),
    }));

    const { default: request } = await import("supertest");
    const { buildApp } = await import("./helpers/app");
    const { testToken } = await import("./helpers/token");
    const app = buildApp();
    const token = testToken("user-1");

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));
    await request(app)
      .post("/payments/charge")
      .set("Authorization", `Bearer ${token}`)
      .send({ orderId: "order-1" });
    vi.setSystemTime(new Date("2024-01-01T00:05:00Z"));
    await request(app)
      .post("/payments/charge")
      .set("Authorization", `Bearer ${token}`)
      .send({ orderId: "order-1" });
    vi.useRealTimers();

    vi.doUnmock("../src/processor");
    vi.doUnmock("../src/db");

    expect(calls).toHaveLength(2);
    expect(calls[1]).toBe(calls[0]);
  });
});
