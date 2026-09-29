import { describe, it, expect } from "vitest";
import { chargeIdempotencyKey } from "../src/utils/tokens";

describe("chargeIdempotencyKey", () => {
  it("returns the same key for the same order id across retries", () => {
    const first = chargeIdempotencyKey("order-1");
    const second = chargeIdempotencyKey("order-1");
    expect(second).toBe(first);
  });

  it("returns the same key for the same order id even after time passes", async () => {
    const before = chargeIdempotencyKey("order-1");
    await new Promise((resolve) => setTimeout(resolve, 5));
    const after = chargeIdempotencyKey("order-1");
    expect(after).toBe(before);
  });

  it("returns different keys for different order ids", () => {
    const keyA = chargeIdempotencyKey("order-1");
    const keyB = chargeIdempotencyKey("order-2");
    expect(keyA).not.toBe(keyB);
  });

  it("includes the order id in the key", () => {
    expect(chargeIdempotencyKey("order-42")).toContain("order-42");
  });
});
