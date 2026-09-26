import { describe, it, expect } from "vitest";
import { slugify, truncate, SLUG_SEPARATOR } from "../src/utils/strings";

describe("slugify", () => {
  it("lowercases and joins words with a separator", () => {
    expect(slugify("Hello World")).toBe("hello-world");
  });

  it("trims and collapses runs of non-alphanumerics", () => {
    expect(slugify("  A--B  ")).toBe("a-b");
  });

  it("returns an empty string for empty input", () => {
    expect(slugify("")).toBe("");
  });

  it("exports the separator constant", () => {
    expect(SLUG_SEPARATOR).toBe("-");
  });
});

describe("truncate", () => {
  it("truncates longer strings and appends an ellipsis", () => {
    expect(truncate("abcdef", 3)).toBe("ab…");
  });

  it("never returns more than n characters including the ellipsis", () => {
    expect(truncate("abcdef", 3).length).toBeLessThanOrEqual(3);
  });

  it("returns an empty string when n is 0", () => {
    expect(truncate("abc", 0)).toBe("");
    expect(truncate("", 0)).toBe("");
  });

  it("returns just the ellipsis when n is 1 and truncation occurs", () => {
    expect(truncate("abc", 1)).toBe("…");
    expect(truncate("a", 1)).toBe("a");
  });

  it("returns the string unchanged when its length equals n", () => {
    expect(truncate("abc", 3)).toBe("abc");
  });

  it("returns short strings unchanged", () => {
    expect(truncate("ab", 3)).toBe("ab");
  });

  it("throws RangeError when n is negative", () => {
    expect(() => truncate("x", -1)).toThrow(RangeError);
  });
});
