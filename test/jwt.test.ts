import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import jwt from "jsonwebtoken";
import {
  signToken,
  verifyToken,
  MAX_CLOCK_SKEW_SECONDS,
} from "../src/utils/jwt";
import * as auth from "../src/auth";
import * as jwtUtils from "../src/utils/jwt";

// Unit tests for the single home of session-token signing and verification.
// The clock is frozen (only `Date` is faked, so jsonwebtoken's `Date.now()` is
// deterministic) and boundary tokens are minted with explicit `iat`/`exp`.
const NOW_SEC = 1_700_000_000;
const SECRET = process.env.JWT_SECRET as string;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW_SEC * 1000);
});

afterEach(() => {
  vi.useRealTimers();
});

function tokenExpiringAt(exp: number, secret: string = SECRET): string {
  return jwt.sign({ sub: "user-42", iat: exp - 3600, exp }, secret, {
    algorithm: "HS256",
  });
}

describe("signToken / verifyToken", () => {
  it("round-trips the payload", () => {
    const token = signToken("user-42");
    const claims = verifyToken<{ sub: string; iat: number; exp: number }>(
      token
    );
    expect(claims.sub).toBe("user-42");
    expect(claims.iat).toBe(NOW_SEC);
    expect(claims.exp).toBe(NOW_SEC + 3600);
  });

  it("rejects a token signed with the wrong secret", () => {
    const bad = tokenExpiringAt(NOW_SEC + 600, "not-the-real-secret");
    expect(() => verifyToken(bad)).toThrow(jwt.JsonWebTokenError);
  });

  it("rejects a token whose payload was tampered with", () => {
    const [header, , signature] = signToken("user-42").split(".");
    const forgedPayload = Buffer.from(
      JSON.stringify({ sub: "admin", iat: NOW_SEC, exp: NOW_SEC + 3600 })
    ).toString("base64url");
    const tampered = `${header}.${forgedPayload}.${signature}`;
    expect(() => verifyToken(tampered)).toThrow(jwt.JsonWebTokenError);
  });

  it("rejects a token whose signature was tampered with", () => {
    const token = signToken("user-42");
    const last = token.slice(-1);
    const tampered = token.slice(0, -1) + (last === "A" ? "B" : "A");
    expect(() => verifyToken(tampered)).toThrow(jwt.JsonWebTokenError);
  });

  it.each(["", "not-a-jwt", "a.b", "a.b.c", "...."])(
    "rejects malformed token %j",
    (bad) => {
      expect(() => verifyToken(bad)).toThrow();
    }
  );

  it("rejects an unsigned (alg: none) token", () => {
    const unsigned = jwt.sign(
      { sub: "user-42", iat: NOW_SEC, exp: NOW_SEC + 600 },
      "",
      { algorithm: "none" }
    );
    expect(() => verifyToken(unsigned)).toThrow(jwt.JsonWebTokenError);
  });
});

describe("verifyToken clock-skew boundary", () => {
  it("exposes a 60 second maximum skew", () => {
    expect(MAX_CLOCK_SKEW_SECONDS).toBe(60);
  });

  it("accepts a token that has not yet expired", () => {
    expect(verifyToken(tokenExpiringAt(NOW_SEC + 600)).sub).toBe("user-42");
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

describe("src/auth re-exports", () => {
  it("re-exports the same functions as src/utils/jwt", () => {
    expect(auth.signToken).toBe(jwtUtils.signToken);
    expect(auth.verifyToken).toBe(jwtUtils.verifyToken);
    expect(auth.MAX_CLOCK_SKEW_SECONDS).toBe(jwtUtils.MAX_CLOCK_SKEW_SECONDS);
  });
});
