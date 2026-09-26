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

    vi.setSystemTime(new Date("2024-01-01T00:05:00Z"));
    const retry = chargeIdempotencyKey("order-1");

    vi.setSystemTime(new Date("2025-06-15T12:34:56Z"));
    const muchLater = chargeIdempotencyKey("order-1");

    expect(retry).toBe(first);
    expect(muchLater).toBe(first);
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

  it("returns a non-empty string that identifies the order", () => {
    const key = chargeIdempotencyKey("order-42");
    expect(typeof key).toBe("string");
    expect(key).toContain("order-42");
  });
});
