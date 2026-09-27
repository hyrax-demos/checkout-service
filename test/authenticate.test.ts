import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { authenticate, AuthedRequest } from "../src/middleware/authenticate";

// Drives the middleware directly with a frozen clock (only `Date` is faked)
// and tokens minted with explicit `iat`/`exp`, so expiry-boundary behaviour is
// deterministic.
describe("authenticate middleware clock-skew tolerance", () => {
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
      { sub: "user-7", role: "admin", iat: exp - 3600, exp },
      process.env.JWT_SECRET as string,
      { algorithm: "HS256" }
    );
  }

  function run(token: string) {
    const req = {
      headers: { authorization: `Bearer ${token}` },
    } as unknown as AuthedRequest;
    const json = vi.fn();
    const status = vi.fn(() => ({ json }));
    const res = { status } as unknown as Response;
    const next = vi.fn() as unknown as NextFunction;
    authenticate(req, res, next);
    return { req, status, json, next };
  }

  function expectAccepted(token: string) {
    const { req, status, next } = run(token);
    expect(next).toHaveBeenCalledOnce();
    expect(status).not.toHaveBeenCalled();
    expect(req.userId).toBe("user-7");
    expect(req.role).toBe("admin");
  }

  function expectRejected(token: string) {
    const { status, json, next } = run(token);
    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledWith({ error: "unauthorized" });
  }

  it("accepts a token that has not expired", () => {
    expectAccepted(tokenExpiringAt(NOW_SEC + 600));
  });

  it("accepts a token that expired 30s ago", () => {
    expectAccepted(tokenExpiringAt(NOW_SEC - 30));
  });

  it("accepts a token that expired exactly 60s ago", () => {
    expectAccepted(tokenExpiringAt(NOW_SEC - 60));
  });

  it("rejects a token that expired 61s ago with 401", () => {
    expectRejected(tokenExpiringAt(NOW_SEC - 61));
  });

  it("rejects a token that expired 25 hours ago with 401", () => {
    expectRejected(tokenExpiringAt(NOW_SEC - 25 * 60 * 60));
  });
});
