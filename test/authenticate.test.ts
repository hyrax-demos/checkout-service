import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import jwt from "jsonwebtoken";
import type { Response } from "express";
import { authenticate, AuthedRequest } from "../src/middleware/authenticate";

// Pinned "now" (whole seconds) so expiry boundaries are exact.
const NOW_SECONDS = 1_700_000_000;

function tokenExpiredSecondsAgo(secondsAgo: number): string {
  const exp = NOW_SECONDS - secondsAgo;
  return jwt.sign(
    { sub: "user-42", role: "admin", iat: exp - 3600, exp },
    process.env.JWT_SECRET as string,
    { algorithm: "HS256" }
  );
}

function run(token: string) {
  const req = {
    headers: { authorization: `Bearer ${token}` },
  } as unknown as AuthedRequest;
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  };
  const next = vi.fn();
  authenticate(req, res as unknown as Response, next);
  return { req, res, next };
}

describe("authenticate middleware clock-skew tolerance", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_SECONDS * 1000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([30, 60])("accepts a token that expired %ss ago", (secondsAgo) => {
    const { req, res, next } = run(tokenExpiredSecondsAgo(secondsAgo));
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
    expect(req.userId).toBe("user-42");
    expect(req.role).toBe("admin");
  });

  it.each([61, 60 * 60])(
    "rejects a token that expired %ss ago with 401",
    (secondsAgo) => {
      const { req, res, next } = run(tokenExpiredSecondsAgo(secondsAgo));
      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ error: "unauthorized" });
      expect(req.userId).toBeUndefined();
    }
  );
});
