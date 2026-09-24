import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { authenticate, AuthedRequest } from "../src/middleware/authenticate";

// Only `Date` is faked so "now" is frozen between signing and verifying,
// while supertest/express timers keep working normally.
const NOW_SECONDS = 1_700_000_000;

function tokenWithExp(exp: number): string {
  return jwt.sign(
    { sub: "user-1", iat: exp - 3600, exp },
    process.env.JWT_SECRET as string,
    { algorithm: "HS256" }
  );
}

function buildApp() {
  const app = express();
  app.get("/protected", authenticate, (req: AuthedRequest, res) => {
    res.json({ userId: req.userId });
  });
  return app;
}

describe("authenticate middleware clock-skew tolerance", () => {
  const app = buildApp();

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW_SECONDS * 1000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("calls next() for a valid unexpired token", async () => {
    const res = await request(app)
      .get("/protected")
      .set("Authorization", `Bearer ${tokenWithExp(NOW_SECONDS + 3600)}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ userId: "user-1" });
  });

  it("calls next() for a token that expired exactly 60 seconds ago", async () => {
    const res = await request(app)
      .get("/protected")
      .set("Authorization", `Bearer ${tokenWithExp(NOW_SECONDS - 60)}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ userId: "user-1" });
  });

  it("returns 401 for a token that expired 61 seconds ago", async () => {
    const res = await request(app)
      .get("/protected")
      .set("Authorization", `Bearer ${tokenWithExp(NOW_SECONDS - 61)}`);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "unauthorized" });
  });

  it("returns 401 for a token that expired 1 hour ago", async () => {
    const res = await request(app)
      .get("/protected")
      .set("Authorization", `Bearer ${tokenWithExp(NOW_SECONDS - 3600)}`);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "unauthorized" });
  });
});
