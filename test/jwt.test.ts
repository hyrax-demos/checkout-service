import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import jwt from "jsonwebtoken";
import {
  signToken,
  verifyToken,
  CLOCK_SKEW_TOLERANCE_SECONDS,
} from "../src/utils/jwt";
import * as auth from "../src/auth";

// Pin the clock so expiry boundaries are exact rather than racing wall time.
const NOW_SECONDS = 1_700_000_000;

// Sign a token whose `exp` is `secondsAgo` seconds before the pinned clock.
function expiredToken(userId: string, secondsAgo: number): string {
  return jwt.sign(
    { sub: userId, iat: NOW_SECONDS - 3600, exp: NOW_SECONDS - secondsAgo },
    process.env.JWT_SECRET as string,
    { algorithm: "HS256" }
  );
}

describe("utils/jwt", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW_SECONDS * 1000));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("tolerates at most 60 seconds of clock skew", () => {
    expect(CLOCK_SKEW_TOLERANCE_SECONDS).toBe(60);
  });

  it("signs and verifies a session token round-trip", () => {
    const claims = verifyToken(signToken("user-42"));
    expect(claims.sub).toBe("user-42");
  });

  it("rejects a token with a tampered signature", () => {
    const token = signToken("user-42");
    const [header, payload, signature] = token.split(".");
    const flipped = (signature[0] === "A" ? "B" : "A") + signature.slice(1);
    expect(() => verifyToken(`${header}.${payload}.${flipped}`)).toThrow(
      jwt.JsonWebTokenError
    );
  });

  it("rejects a token whose payload was tampered with", () => {
    const token = signToken("user-42");
    const [header, , signature] = token.split(".");
    const forged = Buffer.from(
      JSON.stringify({ sub: "admin", exp: NOW_SECONDS + 3600 })
    ).toString("base64url");
    expect(() => verifyToken(`${header}.${forged}.${signature}`)).toThrow(
      jwt.JsonWebTokenError
    );
  });

  it("rejects a malformed token", () => {
    expect(() => verifyToken("not-a-jwt")).toThrow(jwt.JsonWebTokenError);
  });

  it("rejects a token signed with the wrong secret", () => {
    const bad = jwt.sign({ sub: "user-42" }, "not-the-real-secret", {
      algorithm: "HS256",
      expiresIn: 3600,
    });
    expect(() => verifyToken(bad)).toThrow(jwt.JsonWebTokenError);
  });

  it("accepts a token that expired 30 seconds ago", () => {
    expect(verifyToken(expiredToken("user-42", 30)).sub).toBe("user-42");
  });

  it("accepts a token that expired exactly 60 seconds ago", () => {
    expect(verifyToken(expiredToken("user-42", 60)).sub).toBe("user-42");
  });

  it("rejects a token that expired 61 seconds ago", () => {
    expect(() => verifyToken(expiredToken("user-42", 61))).toThrow(
      jwt.TokenExpiredError
    );
  });

  it("rejects a token that expired 120 seconds ago", () => {
    expect(() => verifyToken(expiredToken("user-42", 120))).toThrow(
      jwt.TokenExpiredError
    );
  });
});

describe("src/auth re-exports", () => {
  it("re-exports the same signToken/verifyToken functions", () => {
    expect(auth.signToken).toBe(signToken);
    expect(auth.verifyToken).toBe(verifyToken);
    expect(auth.CLOCK_SKEW_TOLERANCE_SECONDS).toBe(CLOCK_SKEW_TOLERANCE_SECONDS);
  });

  it("interoperates with the utils/jwt implementation", () => {
    expect(verifyToken(auth.signToken("user-7")).sub).toBe("user-7");
    expect(auth.verifyToken(signToken("user-8")).sub).toBe("user-8");
  });
});
