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

    vi.advanceTimersByTime(60 * 60 * 1000);
    const laterRetry = chargeIdempotencyKey("order-1");

    expect(retry).toBe(first);
    expect(laterRetry).toBe(first);
  });

  it("returns different keys for different orders", () => {
    expect(chargeIdempotencyKey("order-1")).not.toBe(
      chargeIdempotencyKey("order-2")
    );
  });

  it("does not collide for order ids that share a prefix", () => {
    expect(chargeIdempotencyKey("order-1")).not.toBe(
      chargeIdempotencyKey("order-10")
    );
  });

  it("includes the order id so the key can be traced back to its order", () => {
    expect(chargeIdempotencyKey("order-42")).toContain("order-42");
  });
});
