import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import jwt from "jsonwebtoken";
import { verifyToken } from "../src/auth";

// Only `Date` is faked so "now" is frozen between signing and verifying,
// making the second-level boundaries deterministic.
const NOW_SECONDS = 1_700_000_000;

function tokenWithExp(exp: number): string {
  return jwt.sign(
    { sub: "user-42", iat: exp - 3600, exp },
    process.env.JWT_SECRET as string,
    { algorithm: "HS256" }
  );
}

describe("verifyToken clock-skew tolerance", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW_SECONDS * 1000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("accepts a valid unexpired token", () => {
    expect(verifyToken(tokenWithExp(NOW_SECONDS + 3600)).sub).toBe("user-42");
  });

  it("accepts a token that expired exactly 60 seconds ago", () => {
    expect(verifyToken(tokenWithExp(NOW_SECONDS - 60)).sub).toBe("user-42");
  });

  it("rejects a token that expired 61 seconds ago with TokenExpiredError", () => {
    expect(() => verifyToken(tokenWithExp(NOW_SECONDS - 61))).toThrow(
      jwt.TokenExpiredError
    );
  });

  it("rejects a token that expired 1 hour ago with TokenExpiredError", () => {
    let caught: unknown;
    try {
      verifyToken(tokenWithExp(NOW_SECONDS - 3600));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(jwt.TokenExpiredError);
    expect((caught as Error).name).toBe("TokenExpiredError");
    expect((caught as Error).message).toBe("jwt expired");
  });

  it("still tolerates up to 60 seconds of nbf skew", () => {
    const token = jwt.sign(
      { sub: "user-42", nbf: NOW_SECONDS + 60, exp: NOW_SECONDS + 3600 },
      process.env.JWT_SECRET as string,
      { algorithm: "HS256" }
    );
    expect(verifyToken(token).sub).toBe("user-42");
  });
});
