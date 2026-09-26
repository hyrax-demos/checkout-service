import { describe, it, expect } from "vitest";
import { applyDiscount, bestDiscountPercent } from "../src/utils/discount";

describe("applyDiscount", () => {
  it("returns the subtotal unchanged when there are no discounts", () => {
    expect(applyDiscount(1234, [])).toBe(1234);
  });

  it("applies a single discount", () => {
    expect(applyDiscount(1000, [10])).toBe(900);
  });

  it("applies only the highest of several discounts (no stacking)", () => {
    expect(applyDiscount(1000, [10, 25, 5])).toBe(750);
  });

  it("treats 0% as no discount", () => {
    expect(applyDiscount(1000, [0])).toBe(1000);
  });

  it("treats 100% as a free subtotal", () => {
    expect(applyDiscount(999, [100])).toBe(0);
  });

  it("rounds the discount half-up to a whole cent", () => {
    // 5 * 10% = 0.5 -> 1 cent off
    expect(applyDiscount(5, [10])).toBe(4);
    // 4 * 10% = 0.4 -> 0 cents off
    expect(applyDiscount(4, [10])).toBe(4);
    // 15 * 10% = 1.5 -> 2 cents off
    expect(applyDiscount(15, [10])).toBe(13);
  });

  it("handles a zero subtotal", () => {
    expect(applyDiscount(0, [50])).toBe(0);
  });

  it("rejects out-of-range percentages", () => {
    expect(() => applyDiscount(1000, [101])).toThrow(/invalid discount percent/);
    expect(() => applyDiscount(1000, [-1])).toThrow(/invalid discount percent/);
    expect(() => applyDiscount(1000, [10, 101])).toThrow(/invalid discount percent/);
  });

  it("rejects non-integer percentages", () => {
    expect(() => applyDiscount(1000, [10.5])).toThrow(/invalid discount percent/);
    expect(() => applyDiscount(1000, [Number.NaN])).toThrow(/invalid discount percent/);
  });

  it("rejects negative or non-integer subtotals", () => {
    expect(() => applyDiscount(-1, [10])).toThrow(/invalid subtotal/);
    expect(() => applyDiscount(10.5, [10])).toThrow(/invalid subtotal/);
  });

  it("does not mutate its inputs", () => {
    const percents = [5, 20, 10];
    applyDiscount(1000, percents);
    expect(percents).toEqual([5, 20, 10]);
  });
});

describe("bestDiscountPercent", () => {
  it("returns 0 for an empty list", () => {
    expect(bestDiscountPercent([])).toBe(0);
  });

  it("returns the highest percentage", () => {
    expect(bestDiscountPercent([3, 40, 12])).toBe(40);
  });
});
