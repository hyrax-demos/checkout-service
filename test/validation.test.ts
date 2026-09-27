import { describe, it, expect } from "vitest";
import {
  isNonEmptyArray,
  isNonEmptyString,
  isNonEmptyStringArray,
  isPositiveIntegerCents,
  isPositiveNumber,
} from "../src/validation";

describe("isPositiveIntegerCents", () => {
  it.each([1, 500, 1999, Number.MAX_SAFE_INTEGER])("accepts %p", (value) => {
    expect(isPositiveIntegerCents(value)).toBe(true);
  });

  it.each([
    0,
    -0,
    -1,
    10.5,
    0.1,
    NaN,
    Infinity,
    -Infinity,
    Number.MAX_SAFE_INTEGER + 1,
    "500",
    null,
    undefined,
    true,
    [500],
    {},
  ])("rejects %p", (value) => {
    expect(isPositiveIntegerCents(value)).toBe(false);
  });
});

describe("isPositiveNumber", () => {
  it.each([0.01, 1, 19.99, 1000])("accepts %p", (value) => {
    expect(isPositiveNumber(value)).toBe(true);
  });

  it.each([0, -0, -0.01, -5, NaN, -Infinity, "5", null, undefined, {}])(
    "rejects %p",
    (value) => {
      expect(isPositiveNumber(value)).toBe(false);
    }
  );
});

describe("isNonEmptyString", () => {
  it.each(["a", "ord_abc", " "])("accepts %p", (value) => {
    expect(isNonEmptyString(value)).toBe(true);
  });

  it.each(["", 0, 1, null, undefined, ["a"], {}, true])("rejects %p", (value) => {
    expect(isNonEmptyString(value)).toBe(false);
  });
});

describe("isNonEmptyArray", () => {
  it.each([[[1]], [["a", "b"]], [[{ sku: "sku-1" }]], [[null]]])(
    "accepts %p",
    (value) => {
      expect(isNonEmptyArray(value)).toBe(true);
    }
  );

  it.each([[[]], ["abc"], [{ length: 1 }], [null], [undefined], [0]])(
    "rejects %p",
    (value) => {
      expect(isNonEmptyArray(value)).toBe(false);
    }
  );
});

describe("isNonEmptyStringArray", () => {
  it.each([[["order-1"]], [["order-1", "order-2"]]])("accepts %p", (value) => {
    expect(isNonEmptyStringArray(value)).toBe(true);
  });

  it.each([
    [[]],
    [[1]],
    [["order-1", 2]],
    [["order-1", ""]],
    [[null]],
    [[{ id: "order-1" }]],
    ["order-1"],
    [null],
    [undefined],
    [{}],
  ])("rejects %p", (value) => {
    expect(isNonEmptyStringArray(value)).toBe(false);
  });
});
