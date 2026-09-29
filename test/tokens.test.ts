import { describe, it, expect, vi, afterEach } from "vitest";
import { chargeIdempotencyKey } from "../src/utils/tokens";

describe("chargeIdempotencyKey", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns the same key for the same order id across retries over time", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));
    const first = chargeIdempotencyKey("order-1");

    vi.setSystemTime(new Date("2030-06-15T12:34:56Z"));
    const second = chargeIdempotencyKey("order-1");

    expect(second).toBe(first);
  });

  it("returns the same key for the same order id when called repeatedly", () => {
    const keys = new Set(
      Array.from({ length: 5 }, () => chargeIdempotencyKey("order-42"))
    );
    expect(keys.size).toBe(1);
  });

  it("returns a different key for a different order id", () => {
    const a = chargeIdempotencyKey("order-1");
    const b = chargeIdempotencyKey("order-2");
    expect(a).not.toBe(b);
  });
});
