import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import jwt from "jsonwebtoken";
import { verifyToken, MAX_CLOCK_SKEW_SECONDS } from "../src/auth";

// Fixed "now" (whole seconds) so expiry boundaries are deterministic.
const NOW_SEC = 1_700_000_000;

function tokenExpiringAt(exp: number): string {
  return jwt.sign(
    { sub: "user-42", iat: exp - 3600, exp },
    process.env.JWT_SECRET as string,
    { algorithm: "HS256" }
  );
}

describe("verifyToken clock-skew tolerance", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW_SEC * 1000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows at most 60 seconds of skew", () => {
    expect(MAX_CLOCK_SKEW_SECONDS).toBe(60);
  });

  it("accepts a valid unexpired token", () => {
    expect(verifyToken(tokenExpiringAt(NOW_SEC + 600)).sub).toBe("user-42");
  });

  it("accepts a token that expired 30 seconds ago", () => {
    expect(verifyToken(tokenExpiringAt(NOW_SEC - 30)).sub).toBe("user-42");
  });

  it("accepts a token that expired exactly 60 seconds ago", () => {
    expect(verifyToken(tokenExpiringAt(NOW_SEC - 60)).sub).toBe("user-42");
  });

  it("rejects a token that expired 61 seconds ago", () => {
    expect(() => verifyToken(tokenExpiringAt(NOW_SEC - 61))).toThrow(
      jwt.TokenExpiredError
    );
  });

  it("rejects a token that expired hours ago (previously within the 24h tolerance)", () => {
    expect(() => verifyToken(tokenExpiringAt(NOW_SEC - 3 * 3600))).toThrow(
      jwt.TokenExpiredError
    );
  });
});
