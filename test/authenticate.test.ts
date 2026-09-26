import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import jwt from "jsonwebtoken";
import { authenticate, AuthedRequest } from "../src/middleware/authenticate";
import { MAX_CLOCK_SKEW_SECONDS } from "../src/auth";

// Pins the clock-skew boundary for the `authenticate` middleware's inline
// `jwt.verify` call: at most MAX_CLOCK_SKEW_SECONDS (60) of skew on an
// expired token is tolerated, down from the old 24-hour tolerance. Time is
// controlled with fake timers so the boundary is exact and does not depend
// on real sleeps.
describe("authenticate middleware clock-skew boundary", () => {
  const nowMs = Date.parse("2024-01-01T00:00:00.000Z");

  function tokenExpiringSecondsAgo(secondsAgo: number): string {
    const nowSeconds = Math.floor(nowMs / 1000);
    return jwt.sign(
      { sub: "user-42", exp: nowSeconds - secondsAgo },
      process.env.JWT_SECRET as string,
      { algorithm: "HS256" }
    );
  }

  function mockReq(token: string): AuthedRequest {
    return {
      headers: { authorization: `Bearer ${token}` },
    } as AuthedRequest;
  }

  function mockRes() {
    return {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(nowMs);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it(`calls next() and attaches the user for a token whose exp is exactly ${MAX_CLOCK_SKEW_SECONDS}s in the past`, () => {
    const token = tokenExpiringSecondsAgo(MAX_CLOCK_SKEW_SECONDS);
    const req = mockReq(token);
    const res = mockRes();
    const next = vi.fn();

    authenticate(req, res as any, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
    expect(req.userId).toBe("user-42");
  });

  it(`responds 401 unauthorized for a token whose exp is ${MAX_CLOCK_SKEW_SECONDS + 1}s in the past`, () => {
    const token = tokenExpiringSecondsAgo(MAX_CLOCK_SKEW_SECONDS + 1);
    const req = mockReq(token);
    const res = mockRes();
    const next = vi.fn();

    authenticate(req, res as any, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: "unauthorized" });
  });

  it("responds 401 unauthorized for a token whose exp is 3600s (1 hour) in the past", () => {
    const token = tokenExpiringSecondsAgo(3600);
    const req = mockReq(token);
    const res = mockRes();
    const next = vi.fn();

    authenticate(req, res as any, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: "unauthorized" });
  });

  it("calls next() and attaches the user for a token that has not expired yet", () => {
    const token = tokenExpiringSecondsAgo(-3600); // expires an hour from now
    const req = mockReq(token);
    const res = mockRes();
    const next = vi.fn();

    authenticate(req, res as any, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
    expect(req.userId).toBe("user-42");
  });
});
