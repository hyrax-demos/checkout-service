import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import jwt from "jsonwebtoken";
import { authenticate, AuthedRequest } from "../src/middleware/authenticate";

const NOW = 1_700_000_000;

function tokenWithExp(exp: number): string {
  return jwt.sign({ sub: "user-42", iat: NOW - 7200, exp }, process.env.JWT_SECRET as string, {
    algorithm: "HS256",
  });
}

function run(token: string) {
  const req = { headers: { authorization: `Bearer ${token}` } } as unknown as AuthedRequest;
  const json = vi.fn();
  const status = vi.fn(() => ({ json }));
  const res = { status } as any;
  const next = vi.fn();
  authenticate(req, res, next);
  return { req, status, json, next };
}

describe("authenticate clock skew", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW * 1000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("accepts an unexpired token", () => {
    const r = run(tokenWithExp(NOW + 3600));
    expect(r.next).toHaveBeenCalled();
    expect(r.req.userId).toBe("user-42");
  });
  it("accepts a token that expired exactly 60s ago", () => {
    const r = run(tokenWithExp(NOW - 60));
    expect(r.next).toHaveBeenCalled();
    expect(r.req.userId).toBe("user-42");
  });
  it("rejects a token that expired 61s ago", () => {
    const r = run(tokenWithExp(NOW - 61));
    expect(r.next).not.toHaveBeenCalled();
    expect(r.status).toHaveBeenCalledWith(401);
    expect(r.json).toHaveBeenCalledWith({ error: "unauthorized" });
  });
  it("rejects a token that expired 1 hour ago", () => {
    const r = run(tokenWithExp(NOW - 3600));
    expect(r.next).not.toHaveBeenCalled();
    expect(r.status).toHaveBeenCalledWith(401);
  });
});
