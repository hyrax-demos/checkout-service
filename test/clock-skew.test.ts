import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import jwt from "jsonwebtoken";
import { verifyToken } from "../src/auth";
import { authenticate, AuthedRequest } from "../src/middleware/authenticate";

// Pinned wall clock (whole seconds) so the expiry boundary is deterministic.
const NOW_SECONDS = 1_700_000_000;

// Sign a token whose `exp` is `secondsAgo` seconds before the pinned clock.
function tokenExpiredAgo(secondsAgo: number): string {
  const exp = NOW_SECONDS - secondsAgo;
  return jwt.sign(
    { sub: "user-42", iat: exp - 3600, exp },
    process.env.JWT_SECRET as string,
    { algorithm: "HS256" }
  );
}

function runAuthenticate(token: string) {
  const req = { headers: { authorization: `Bearer ${token}` } } as AuthedRequest;
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
  };
  const next = vi.fn();
  authenticate(req, res as never, next);
  return { req, res, next };
}

const cases: Array<{ label: string; secondsAgo: number; accepted: boolean }> = [
  { label: "expired 30s ago", secondsAgo: 30, accepted: true },
  { label: "expired exactly 60s ago", secondsAgo: 60, accepted: true },
  { label: "expired 61s ago", secondsAgo: 61, accepted: false },
  { label: "expired 1 hour ago", secondsAgo: 60 * 60, accepted: false },
];

describe("session token clock-skew tolerance", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW_SECONDS * 1000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("verifyToken", () => {
    for (const { label, secondsAgo, accepted } of cases) {
      it(`${accepted ? "accepts" : "rejects"} a token ${label}`, () => {
        const token = tokenExpiredAgo(secondsAgo);
        if (accepted) {
          expect(verifyToken(token).sub).toBe("user-42");
        } else {
          expect(() => verifyToken(token)).toThrow(jwt.TokenExpiredError);
        }
      });
    }
  });

  describe("authenticate middleware", () => {
    for (const { label, secondsAgo, accepted } of cases) {
      it(`${accepted ? "accepts" : "rejects"} a token ${label}`, () => {
        const { req, res, next } = runAuthenticate(tokenExpiredAgo(secondsAgo));
        if (accepted) {
          expect(next).toHaveBeenCalledTimes(1);
          expect(req.userId).toBe("user-42");
          expect(res.statusCode).toBe(200);
        } else {
          expect(next).not.toHaveBeenCalled();
          expect(res.statusCode).toBe(401);
          expect(res.body).toEqual({ error: "unauthorized" });
        }
      });
    }
  });
});
