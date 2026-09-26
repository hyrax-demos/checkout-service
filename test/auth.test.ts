import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import jwt from "jsonwebtoken";
import {
  signToken,
  verifyToken,
  hashPassword,
  verifyPassword,
  MAX_CLOCK_SKEW_SECONDS,
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

// Pins the clock-skew boundary for `verifyToken`: at most
// MAX_CLOCK_SKEW_SECONDS (60) of skew on an expired token is tolerated, down
// from the old 24-hour tolerance. Time is controlled with fake timers so the
// boundary is exact and does not depend on real sleeps.
describe("verifyToken clock-skew boundary", () => {
  const nowMs = Date.parse("2024-01-01T00:00:00.000Z");

  function tokenExpiringSecondsAgo(secondsAgo: number): string {
    const nowSeconds = Math.floor(nowMs / 1000);
    return jwt.sign(
      { sub: "user-42", exp: nowSeconds - secondsAgo },
      process.env.JWT_SECRET as string,
      { algorithm: "HS256" }
    );
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(nowMs);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it(`accepts a token whose exp is exactly ${MAX_CLOCK_SKEW_SECONDS}s in the past`, () => {
    const token = tokenExpiringSecondsAgo(MAX_CLOCK_SKEW_SECONDS);
    expect(verifyToken(token).sub).toBe("user-42");
  });

  it(`rejects a token whose exp is ${MAX_CLOCK_SKEW_SECONDS + 1}s in the past`, () => {
    const token = tokenExpiringSecondsAgo(MAX_CLOCK_SKEW_SECONDS + 1);
    expect(() => verifyToken(token)).toThrow(jwt.TokenExpiredError);
  });

  it("rejects a token whose exp is 3600s (1 hour) in the past", () => {
    const token = tokenExpiringSecondsAgo(3600);
    expect(() => verifyToken(token)).toThrow(jwt.TokenExpiredError);
  });

  it("accepts a token that has not expired yet", () => {
    const token = tokenExpiringSecondsAgo(-3600); // expires an hour from now
    expect(verifyToken(token).sub).toBe("user-42");
  });
});
