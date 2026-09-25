import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import jwt from "jsonwebtoken";
import { verifyToken, MAX_CLOCK_SKEW_SECONDS } from "../src/auth";

// Pinned "now" (whole seconds) so expiry boundaries are exact.
const NOW_SECONDS = 1_700_000_000;

function tokenExpiredSecondsAgo(secondsAgo: number): string {
  const exp = NOW_SECONDS - secondsAgo;
  return jwt.sign(
    { sub: "user-42", iat: exp - 3600, exp },
    process.env.JWT_SECRET as string,
    { algorithm: "HS256" }
  );
}

describe("verifyToken clock-skew tolerance", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_SECONDS * 1000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows at most 60 seconds of skew", () => {
    expect(MAX_CLOCK_SKEW_SECONDS).toBe(60);
  });

  it("accepts a token that expired 30s ago", () => {
    expect(verifyToken(tokenExpiredSecondsAgo(30)).sub).toBe("user-42");
  });

  it("accepts a token that expired exactly 60s ago", () => {
    expect(verifyToken(tokenExpiredSecondsAgo(60)).sub).toBe("user-42");
  });

  it("accepts a token that expired exactly 60s ago even late in that second", () => {
    vi.setSystemTime(NOW_SECONDS * 1000 + 999);
    expect(verifyToken(tokenExpiredSecondsAgo(60)).sub).toBe("user-42");
  });

  it("rejects a token that expired 61s ago", () => {
    expect(() => verifyToken(tokenExpiredSecondsAgo(61))).toThrow(
      jwt.TokenExpiredError
    );
  });

  it("rejects a token that expired 1 hour ago", () => {
    expect(() => verifyToken(tokenExpiredSecondsAgo(60 * 60))).toThrow(
      jwt.TokenExpiredError
    );
  });
});
