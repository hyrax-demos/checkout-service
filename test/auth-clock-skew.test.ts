import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import jwt from "jsonwebtoken";
import { verifyToken, MAX_CLOCK_SKEW_SECONDS } from "../src/auth";

// Pins the session-token clock-skew boundary for `verifyToken`. Time is
// frozen by faking `Date` only, and tokens carry an explicit `exp`.
const NOW_SECONDS = 1_700_000_000;

function tokenExpiringAt(exp: number): string {
  return jwt.sign(
    { sub: "user-42", iat: exp - 3600, exp },
    process.env.JWT_SECRET as string,
    { algorithm: "HS256" }
  );
}

describe("verifyToken clock skew", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW_SECONDS * 1000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows at most 60 seconds of skew", () => {
    expect(MAX_CLOCK_SKEW_SECONDS).toBe(60);
  });

  it("accepts a token that has not expired yet", () => {
    expect(verifyToken(tokenExpiringAt(NOW_SECONDS + 600)).sub).toBe("user-42");
  });

  it("accepts a token 59s past expiry", () => {
    expect(verifyToken(tokenExpiringAt(NOW_SECONDS - 59)).sub).toBe("user-42");
  });

  it("accepts a token exactly 60s past expiry", () => {
    expect(verifyToken(tokenExpiringAt(NOW_SECONDS - 60)).sub).toBe("user-42");
  });

  it("accepts a token exactly 60s past expiry even late within that second", () => {
    vi.setSystemTime(NOW_SECONDS * 1000 + 999);
    expect(verifyToken(tokenExpiringAt(NOW_SECONDS - 60)).sub).toBe("user-42");
  });

  it("rejects a token 61s past expiry", () => {
    expect(() => verifyToken(tokenExpiringAt(NOW_SECONDS - 61))).toThrow(
      jwt.TokenExpiredError
    );
  });

  it("rejects a token 2 hours past expiry", () => {
    expect(() => verifyToken(tokenExpiringAt(NOW_SECONDS - 2 * 60 * 60))).toThrow(
      jwt.TokenExpiredError
    );
  });
});
