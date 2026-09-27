import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { authenticate, AuthedRequest } from "../src/middleware/authenticate";

// Sign a token whose `exp` is `secondsAgo` seconds in the past.
function expiredToken(userId: string, secondsAgo: number): string {
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign(
    { sub: userId, iat: now - 3600, exp: now - secondsAgo },
    process.env.JWT_SECRET as string,
    { algorithm: "HS256" }
  );
}

function buildProtectedApp() {
  const app = express();
  app.get("/whoami", authenticate, (req: AuthedRequest, res) =>
    res.json({ userId: req.userId })
  );
  return app;
}

describe("authenticate middleware clock-skew tolerance", () => {
  const app = buildProtectedApp();

  it("accepts a token that expired 30 seconds ago", async () => {
    const res = await request(app)
      .get("/whoami")
      .set("Authorization", `Bearer ${expiredToken("user-1", 30)}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ userId: "user-1" });
  });

  it("rejects a token that expired 120 seconds ago", async () => {
    const res = await request(app)
      .get("/whoami")
      .set("Authorization", `Bearer ${expiredToken("user-1", 120)}`);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "unauthorized" });
  });
});
