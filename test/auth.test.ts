import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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

describe("verifyToken clock-skew tolerance", () => {
  // Frozen clock: only `Date` is faked, so jsonwebtoken's `Date.now()` is
  // deterministic without affecting any other timers.
  const NOW_SEC = 1_700_000_000;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW_SEC * 1000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function tokenExpiringAt(exp: number): string {
    return jwt.sign(
      { sub: "user-42", iat: exp - 3600, exp },
      process.env.JWT_SECRET as string,
      { algorithm: "HS256" }
    );
  }

  it("exposes a 60 second maximum skew", () => {
    expect(MAX_CLOCK_SKEW_SECONDS).toBe(60);
  });

  it("accepts a token that has not expired", () => {
    expect(verifyToken(tokenExpiringAt(NOW_SEC + 600)).sub).toBe("user-42");
  });

  it("accepts a token that expired 30s ago", () => {
    expect(verifyToken(tokenExpiringAt(NOW_SEC - 30)).sub).toBe("user-42");
  });

  it("accepts a token that expired exactly 60s ago", () => {
    expect(verifyToken(tokenExpiringAt(NOW_SEC - 60)).sub).toBe("user-42");
  });

  it("rejects a token that expired 61s ago", () => {
    expect(() => verifyToken(tokenExpiringAt(NOW_SEC - 61))).toThrow(
      jwt.TokenExpiredError
    );
  });

  it("rejects a token that expired 25 hours ago", () => {
    expect(() =>
      verifyToken(tokenExpiringAt(NOW_SEC - 25 * 60 * 60))
    ).toThrow(jwt.TokenExpiredError);
  });
});
