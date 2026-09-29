import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import jwt from "jsonwebtoken";
import request from "supertest";
import { verifyToken } from "../src/auth";
import type { Response } from "express";
import { buildApp } from "./helpers/app";
import { authenticate, AuthedRequest } from "../src/middleware/authenticate";

const NOW = 1_700_000_000; // fixed epoch seconds

function expiredAgo(seconds: number): string {
  return jwt.sign(
    { sub: "user-42", iat: NOW - 3600 - seconds, exp: NOW - seconds },
    process.env.JWT_SECRET as string,
    { algorithm: "HS256" }
  );
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW * 1000);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("verifyToken clock skew", () => {
  it("accepts a token expired 30s ago", () => {
    expect(verifyToken(expiredAgo(30)).sub).toBe("user-42");
  });
  it("accepts a token expired exactly 60s ago", () => {
    expect(verifyToken(expiredAgo(60)).sub).toBe("user-42");
  });
  it("rejects a token expired 61s ago with TokenExpiredError", () => {
    expect(() => verifyToken(expiredAgo(61))).toThrow(jwt.TokenExpiredError);
  });
  it("rejects a token expired 2 hours ago with TokenExpiredError", () => {
    expect(() => verifyToken(expiredAgo(2 * 60 * 60))).toThrow(jwt.TokenExpiredError);
  });
});

describe("authenticate middleware clock skew", () => {
  const app = buildApp();
  it("rejects a token expired more than 60s ago with 401", async () => {
    const res = await request(app)
      .get("/orders")
      .set("Authorization", `Bearer ${expiredAgo(61)}`);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "unauthorized" });
  });
  it("lets a token expired at most 60s ago through authenticate", () => {
    for (const ago of [30, 60]) {
      const req = { headers: { authorization: `Bearer ${expiredAgo(ago)}` } } as AuthedRequest;
      const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
      const next = vi.fn();
      authenticate(req, res as unknown as Response, next);
      expect(next).toHaveBeenCalledOnce();
      expect(res.status).not.toHaveBeenCalled();
      expect(req.userId).toBe("user-42");
    }
  });
});
