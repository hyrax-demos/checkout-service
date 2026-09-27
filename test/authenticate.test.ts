import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { authenticate, AuthedRequest } from "../src/middleware/authenticate";

// Fixed "now" (whole seconds) so expiry boundaries are deterministic. Only
// `Date` is faked so supertest/express timers keep working.
const NOW_SEC = 1_700_000_000;

function tokenExpiringAt(exp: number): string {
  return jwt.sign(
    { sub: "user-1", iat: exp - 3600, exp },
    process.env.JWT_SECRET as string,
    { algorithm: "HS256" }
  );
}

function buildApp() {
  const app = express();
  app.get("/whoami", authenticate, (req: AuthedRequest, res) => {
    res.json({ userId: req.userId });
  });
  return app;
}

describe("authenticate middleware clock-skew tolerance", () => {
  const app = buildApp();

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW_SEC * 1000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("passes through a token that expired within the last 60 seconds", async () => {
    const res = await request(app)
      .get("/whoami")
      .set("Authorization", `Bearer ${tokenExpiringAt(NOW_SEC - 60)}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ userId: "user-1" });
  });

  it("rejects a token that expired 61 seconds ago like any other invalid token", async () => {
    const expired = await request(app)
      .get("/whoami")
      .set("Authorization", `Bearer ${tokenExpiringAt(NOW_SEC - 61)}`);
    const garbage = await request(app)
      .get("/whoami")
      .set("Authorization", "Bearer not-a-jwt");

    expect(expired.status).toBe(401);
    expect(expired.body).toEqual({ error: "unauthorized" });
    expect(expired.status).toBe(garbage.status);
    expect(expired.body).toEqual(garbage.body);
  });
});
