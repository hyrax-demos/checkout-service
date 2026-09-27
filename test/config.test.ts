import { describe, it, expect } from "vitest";
import { DEFAULT_REFUND_MAX_CENTS, parseRefundMaxCents } from "../src/config";

describe("parseRefundMaxCents", () => {
  it("defaults to 50000 cents when unset or empty", () => {
    expect(DEFAULT_REFUND_MAX_CENTS).toBe(50000);
    expect(parseRefundMaxCents(undefined)).toBe(50000);
    expect(parseRefundMaxCents("")).toBe(50000);
    expect(parseRefundMaxCents("   ")).toBe(50000);
  });

  it("parses an integer number of cents", () => {
    expect(parseRefundMaxCents("2500")).toBe(2500);
    expect(parseRefundMaxCents(" 100000 ")).toBe(100000);
    expect(parseRefundMaxCents("0")).toBe(0);
  });

  it("rejects malformed values instead of silently disabling the ceiling", () => {
    for (const bad of ["abc", "-1", "12.5", "1e5", "500 dollars", "Infinity"]) {
      expect(() => parseRefundMaxCents(bad)).toThrow(/REFUND_MAX_CENTS/);
    }
  });
});
