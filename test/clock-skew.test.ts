import { describe, it, expect } from "vitest";
import jwt from "jsonwebtoken";
import { verifyToken, CLOCK_SKEW_TOLERANCE_SECONDS } from "../src/auth";

// Sign a token whose `exp` is `secondsAgo` seconds in the past.
function expiredToken(userId: string, secondsAgo: number): string {
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign(
    { sub: userId, iat: now - 3600, exp: now - secondsAgo },
    process.env.JWT_SECRET as string,
    { algorithm: "HS256" }
  );
}

describe("verifyToken clock-skew tolerance", () => {
  it("tolerates at most 60 seconds of clock skew", () => {
    expect(CLOCK_SKEW_TOLERANCE_SECONDS).toBe(60);
  });

  it("accepts a token that expired 30 seconds ago", () => {
    const claims = verifyToken(expiredToken("user-42", 30));
    expect(claims.sub).toBe("user-42");
  });

  it("rejects a token that expired 120 seconds ago", () => {
    expect(() => verifyToken(expiredToken("user-42", 120))).toThrow(
      jwt.TokenExpiredError
    );
  });
});
