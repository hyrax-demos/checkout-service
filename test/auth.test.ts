import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import jwt from "jsonwebtoken";
import {
  signToken,
  verifyToken,
  hashPassword,
  verifyPassword,
} from "../src/auth";

// Deliberately does not assert on `clockTolerance` — that value is a bench
// task's fix target (M4), and a correct fix must still pass this file
// unedited.
describe("auth helpers", () => {
  it("signs and verifies a session token round-trip", () => {
    const token = signToken("user-42");
    const claims = verifyToken(token);
    expect(claims.sub).toBe("user-42");
  });

  it("rejects a token signed with the wrong secret", () => {
    const bad = jwt.sign({ sub: "user-42" }, "not-the-real-secret", {
      algorithm: "HS256",
      expiresIn: 3600,
    });
    expect(() => verifyToken(bad)).toThrow();
  });

  it("hashes and verifies a password", () => {
    const hash = hashPassword("correct horse battery staple");
    expect(verifyPassword("correct horse battery staple", hash)).toBe(true);
    expect(verifyPassword("wrong password", hash)).toBe(false);
  });
});

describe("verifyToken clock skew", () => {
  const NOW = 1_700_000_000;
  const tokenWithExp = (exp: number) =>
    jwt.sign({ sub: "user-42", iat: NOW - 7200, exp }, process.env.JWT_SECRET as string, {
      algorithm: "HS256",
    });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW * 1000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("accepts an unexpired token", () => {
    expect(verifyToken(tokenWithExp(NOW + 3600)).sub).toBe("user-42");
  });
  it("accepts a token that expired exactly 60s ago", () => {
    expect(verifyToken(tokenWithExp(NOW - 60)).sub).toBe("user-42");
  });
  it("rejects a token that expired 61s ago", () => {
    expect(() => verifyToken(tokenWithExp(NOW - 61))).toThrow();
  });
  it("rejects a token that expired 1 hour ago", () => {
    expect(() => verifyToken(tokenWithExp(NOW - 3600))).toThrow();
  });
});
