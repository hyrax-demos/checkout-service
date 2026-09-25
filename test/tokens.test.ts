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
    expect(second).toBe(first);
  });

  it("returns the same key on repeated calls without a clock change", () => {
    expect(chargeIdempotencyKey("order-1")).toBe(
      chargeIdempotencyKey("order-1")
    );
  });

  it("returns different keys for different orders", () => {
    expect(chargeIdempotencyKey("order-1")).not.toBe(
      chargeIdempotencyKey("order-2")
    );
  });
});
