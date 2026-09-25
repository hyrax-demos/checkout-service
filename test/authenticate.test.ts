import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { authenticate, AuthedRequest } from "../src/middleware/authenticate";

// Pins the session-token clock-skew boundary for the `authenticate`
// middleware. Only `Date` is faked so supertest's real timers/sockets work.
const NOW_SECONDS = 1_700_000_000;

function tokenExpiringAt(exp: number): string {
  return jwt.sign(
    { sub: "user-42", role: "admin", iat: exp - 3600, exp },
    process.env.JWT_SECRET as string,
    { algorithm: "HS256" }
  );
}

function buildApp() {
  const app = express();
  app.use(authenticate);
  app.get("/whoami", (req: AuthedRequest, res) =>
    res.json({ userId: req.userId, role: req.role })
  );
  return app;
}

describe("authenticate middleware clock skew", () => {
  const app = buildApp();

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW_SECONDS * 1000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function call(exp: number) {
    return request(app)
      .get("/whoami")
      .set("Authorization", `Bearer ${tokenExpiringAt(exp)}`);
  }

  it.each([
    ["not yet expired", 600],
    ["59s past expiry", -59],
    ["exactly 60s past expiry", -60],
  ])("accepts a token %s", async (_label, offset) => {
    const res = await call(NOW_SECONDS + offset);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ userId: "user-42", role: "admin" });
  });

  it.each([
    ["61s past expiry", -61],
    ["2 hours past expiry", -2 * 60 * 60],
  ])("rejects a token %s with the existing 401 shape", async (_label, offset) => {
    const res = await call(NOW_SECONDS + offset);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "unauthorized" });
  });

  it("still rejects a missing token with 401", async () => {
    const res = await request(app).get("/whoami");
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "unauthorized" });
  });
});
