import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import jwt from "jsonwebtoken";
import { signToken, verifyToken, MAX_CLOCK_SKEW_SECONDS } from "../../src/utils/jwt";
import * as authModule from "../../src/auth";

describe("jwt helpers", () => {
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

  it("rejects a token signed with an unexpected algorithm", () => {
    const bad = jwt.sign({ sub: "user-42" }, process.env.JWT_SECRET as string, {
      algorithm: "HS384",
      expiresIn: 3600,
    });
    expect(() => verifyToken(bad)).toThrow();
  });

  it("rejects a token whose payload segment has been tampered with", () => {
    const token = signToken("user-42");
    const [headerB64, payloadB64, sigB64] = token.split(".");
    const tamperedPayload = Buffer.from(JSON.stringify({ sub: "someone-else" })).toString(
      "base64url"
    );
    const tampered = `${headerB64}.${tamperedPayload}.${sigB64}`;
    expect(() => verifyToken(tampered)).toThrow();
  });

  it("rejects a token whose signature segment has been tampered with", () => {
    const token = signToken("user-42");
    const [headerB64, payloadB64, sigB64] = token.split(".");
    // Flip a character in the middle of the signature so it no longer
    // matches. (Flipping only the last character is fragile: some
    // base64url character pairs, like "A"/"B", differ only in padding
    // bits that don't affect every comparison path.)
    const mid = Math.floor(sigB64.length / 2);
    const midChar = sigB64[mid];
    const replacement = midChar === "x" ? "y" : "x";
    const flipped = sigB64.slice(0, mid) + replacement + sigB64.slice(mid + 1);
    const tampered = `${headerB64}.${payloadB64}.${flipped}`;
    expect(() => verifyToken(tampered)).toThrow();
  });

  it("rejects a malformed token string", () => {
    expect(() => verifyToken("not-a-jwt-at-all")).toThrow();
  });

  it("rejects an empty token string", () => {
    expect(() => verifyToken("")).toThrow();
  });

  it("exposes a 60-second max clock skew", () => {
    expect(MAX_CLOCK_SKEW_SECONDS).toBe(60);
  });
});

// `src/auth.ts` re-exports `signToken`/`verifyToken`/`MAX_CLOCK_SKEW_SECONDS`
// from `src/utils/jwt.ts` rather than defining its own copies, so old import
// sites (`import { signToken } from "./auth"`) keep working. Pin that the
// re-exports really are the same functions/value, not look-alike copies.
describe("src/auth.ts re-export compatibility", () => {
  it("re-exports the exact same signToken/verifyToken functions", () => {
    expect(authModule.signToken).toBe(signToken);
    expect(authModule.verifyToken).toBe(verifyToken);
  });

  it("re-exports the same MAX_CLOCK_SKEW_SECONDS value", () => {
    expect(authModule.MAX_CLOCK_SKEW_SECONDS).toBe(MAX_CLOCK_SKEW_SECONDS);
  });

  it("interoperates: a token signed via src/auth.ts verifies via src/utils/jwt.ts and vice versa", () => {
    const tokenFromAuth = authModule.signToken("user-42");
    expect(verifyToken(tokenFromAuth).sub).toBe("user-42");

    const tokenFromJwt = signToken("user-99");
    expect(authModule.verifyToken(tokenFromJwt).sub).toBe("user-99");
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

  it("rejects a token whose exp is 86400s (24 hours, the old tolerance) in the past", () => {
    const token = tokenExpiringSecondsAgo(86400);
    expect(() => verifyToken(token)).toThrow(jwt.TokenExpiredError);
  });

  it("accepts a token that has not expired yet", () => {
    const token = tokenExpiringSecondsAgo(-3600); // expires an hour from now
    expect(verifyToken(token).sub).toBe("user-42");
  });
});
