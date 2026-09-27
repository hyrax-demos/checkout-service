import { describe, it, expect, vi, afterEach } from "vitest";
import { chargeIdempotencyKey } from "../src/utils/tokens";

describe("chargeIdempotencyKey", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns the same key for the same order id across calls", () => {
    const first = chargeIdempotencyKey("order-1");
    const second = chargeIdempotencyKey("order-1");
    expect(first).toBe(second);
  });

  it("returns the same key for the same order id even when time has moved on", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const first = chargeIdempotencyKey("order-retry");

    vi.setSystemTime(10_000_000);
    const second = chargeIdempotencyKey("order-retry");

    expect(first).toBe(second);
  });

  it("returns different keys for different order ids", () => {
    const a = chargeIdempotencyKey("order-1");
    const b = chargeIdempotencyKey("order-2");
    expect(a).not.toBe(b);
  });

  it("is prefixed with charge_ and does not leak the raw order id", () => {
    const key = chargeIdempotencyKey("order-super-secret-id");
    expect(key.startsWith("charge_")).toBe(true);
    expect(key).not.toContain("order-super-secret-id");
  });
});
