import { describe, it, expect } from "vitest";
import { DEFAULT_REFUND_MAX_CENTS, parseRefundMaxCents } from "../src/config";

describe("parseRefundMaxCents", () => {
  it("defaults to 50000 cents when unset or empty", () => {
    expect(DEFAULT_REFUND_MAX_CENTS).toBe(50000);
    expect(parseRefundMaxCents(undefined)).toBe(50000);
    expect(parseRefundMaxCents("")).toBe(50000);
    expect(parseRefundMaxCents("   ")).toBe(50000);
  });

  it("parses a positive integer number of cents", () => {
    expect(parseRefundMaxCents("1")).toBe(1);
    expect(parseRefundMaxCents("125000")).toBe(125000);
    expect(parseRefundMaxCents(" 2500 ")).toBe(2500);
  });

  it.each(["abc", "12.5", "-100", "0", "1e5", "0x10", "9007199254740993"])(
    "rejects malformed value %j",
    (raw) => {
      expect(() => parseRefundMaxCents(raw)).toThrow(/REFUND_MAX_CENTS/);
    }
  );
});
