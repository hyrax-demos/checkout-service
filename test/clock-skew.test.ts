import { describe, it, expect, vi } from "vitest";
import jwt from "jsonwebtoken";
import type { Response, NextFunction } from "express";
import { verifyToken } from "../src/auth";
import { authenticate, AuthedRequest } from "../src/middleware/authenticate";

// Session tokens may be accepted for at most 60 seconds past `exp` to absorb
// clock drift. Anything older must be rejected by every verification path.

function tokenExpiredSecondsAgo(secondsAgo: number, role?: string): string {
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign(
    {
      sub: "user-skew",
      ...(role ? { role } : {}),
      iat: now - 3600 - secondsAgo,
      exp: now - secondsAgo,
    },
    process.env.JWT_SECRET as string,
    { algorithm: "HS256" }
  );
}

function runMiddleware(token: string) {
  const req = {
    headers: { authorization: `Bearer ${token}` },
  } as unknown as AuthedRequest;
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  };
  const next = vi.fn() as unknown as NextFunction;
  authenticate(req, res as unknown as Response, next);
  return { req, res, next: next as unknown as ReturnType<typeof vi.fn> };
}

describe("session token clock-skew tolerance", () => {
  describe("verifyToken (src/auth.ts)", () => {
    it.each([61, 90, 60 * 60, 60 * 60 * 23])(
      "rejects a token that expired %i seconds ago",
      (secondsAgo) => {
        expect(() => verifyToken(tokenExpiredSecondsAgo(secondsAgo))).toThrow(
          jwt.TokenExpiredError
        );
      }
    );

    it.each([1, 30, 55])(
      "accepts a token that expired %i seconds ago",
      (secondsAgo) => {
        const claims = verifyToken(tokenExpiredSecondsAgo(secondsAgo));
        expect(claims.sub).toBe("user-skew");
      }
    );
  });

  describe("authenticate middleware (src/middleware/authenticate.ts)", () => {
    it.each([61, 90, 60 * 60, 60 * 60 * 23])(
      "responds 401 for a token that expired %i seconds ago",
      (secondsAgo) => {
        const { req, res, next } = runMiddleware(
          tokenExpiredSecondsAgo(secondsAgo, "admin")
        );
        expect(next).not.toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(401);
        expect(res.json).toHaveBeenCalledWith({ error: "unauthorized" });
        expect(req.userId).toBeUndefined();
        expect(req.role).toBeUndefined();
      }
    );

    it.each([1, 30, 55])(
      "accepts a token that expired %i seconds ago",
      (secondsAgo) => {
        const { req, res, next } = runMiddleware(
          tokenExpiredSecondsAgo(secondsAgo, "admin")
        );
        expect(next).toHaveBeenCalledTimes(1);
        expect(next).toHaveBeenCalledWith();
        expect(res.status).not.toHaveBeenCalled();
        expect(req.userId).toBe("user-skew");
        expect(req.role).toBe("admin");
      }
    );
  });
});
