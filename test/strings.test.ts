import { describe, it, expect } from "vitest";
import { slugify, SLUG_SEPARATOR } from "../src/utils/strings";

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
