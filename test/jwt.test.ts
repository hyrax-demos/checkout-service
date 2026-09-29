import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import jwt from "jsonwebtoken";
import { config } from "../src/config";
import {
  CLOCK_SKEW_TOLERANCE_SECONDS,
  signToken,
  verifyToken,
} from "../src/utils/jwt";
import * as auth from "../src/auth";

const NOW_SECONDS = 1_700_000_000;

// Token signed validly with the real secret/algorithm, so expiry is the only
// possible reason for rejection.
function tokenWithExp(exp: number): string {
  return jwt.sign({ sub: "user-42", iat: exp - 3600, exp }, config.jwtSecret, {
    algorithm: "HS256",
  });
}

describe("utils/jwt", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW_SECONDS * 1000));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("round-trips a token from signToken through verifyToken", () => {
    const claims = verifyToken(signToken("user-42")) as { sub: string; exp: number; iat: number };
    expect(claims.sub).toBe("user-42");
    expect(claims.iat).toBe(NOW_SECONDS);
    expect(claims.exp).toBe(NOW_SECONDS + 3600);
  });

  it("rejects a token with a tampered payload", () => {
    const [header, , signature] = signToken("user-42").split(".");
    const forged = Buffer.from(
      JSON.stringify({ sub: "admin", iat: NOW_SECONDS, exp: NOW_SECONDS + 3600 }),
    ).toString("base64url");
    expect(() => verifyToken(`${header}.${forged}.${signature}`)).toThrow();
  });

  it("rejects a token with a tampered signature", () => {
    const token = signToken("user-42");
    const last = token.slice(-1);
    const tampered = token.slice(0, -1) + (last === "A" ? "B" : "A");
    expect(() => verifyToken(tampered)).toThrow();
  });

  it("rejects a token signed with a different secret", () => {
    const bad = jwt.sign({ sub: "user-42" }, "not-the-real-secret", {
      algorithm: "HS256",
      expiresIn: 3600,
    });
    expect(() => verifyToken(bad)).toThrow();
  });

  it("accepts an unexpired token", () => {
    expect(verifyToken(tokenWithExp(NOW_SECONDS + 600)).sub).toBe("user-42");
  });

  it("accepts a token whose exp is exactly 60s in the past", () => {
    expect(verifyToken(tokenWithExp(NOW_SECONDS - 60)).sub).toBe("user-42");
  });

  it("rejects a token whose exp is 61s in the past", () => {
    expect(() => verifyToken(tokenWithExp(NOW_SECONDS - 61))).toThrow(jwt.TokenExpiredError);
  });

  it("rejects a token whose exp is 1 hour in the past", () => {
    expect(() => verifyToken(tokenWithExp(NOW_SECONDS - 3600))).toThrow(jwt.TokenExpiredError);
  });

  it("rejects a token whose exp is 24 hours in the past", () => {
    expect(() => verifyToken(tokenWithExp(NOW_SECONDS - 86400))).toThrow(
      jwt.TokenExpiredError,
    );
  });

  it("exports a 60 second clock-skew tolerance", () => {
    expect(CLOCK_SKEW_TOLERANCE_SECONDS).toBe(60);
  });

  it("re-exports the same functions from src/auth", () => {
    expect(auth.signToken).toBe(signToken);
    expect(auth.verifyToken).toBe(verifyToken);
    expect(auth.verifyToken(signToken("user-7")).sub).toBe("user-7");
  });
});
