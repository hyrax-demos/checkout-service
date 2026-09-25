import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import jwt from "jsonwebtoken";
import * as jwtUtils from "../src/utils/jwt";
import * as auth from "../src/auth";
import {
  MAX_CLOCK_SKEW_SECONDS,
  SESSION_CLOCK_TOLERANCE,
  signToken,
  verifyToken,
} from "../src/utils/jwt";

// Dedicated unit tests for the shared session-token module. Time is frozen by
// faking `Date` only (jsonwebtoken reads `Date.now()`), so no real sleeps.
const NOW_SECONDS = 1_700_000_000;
const SECRET = process.env.JWT_SECRET as string;

function tokenExpiringAt(exp: number, secret: string = SECRET): string {
  return jwt.sign({ sub: "user-42", iat: exp - 3600, exp }, secret, {
    algorithm: "HS256",
  });
}

function base64UrlJson(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

describe("utils/jwt", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW_SECONDS * 1000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("constants", () => {
    it("allows at most 60 seconds of clock skew", () => {
      expect(MAX_CLOCK_SKEW_SECONDS).toBe(60);
    });

    it("derives the library tolerance from the skew constant", () => {
      // jsonwebtoken rejects when now >= exp + clockTolerance, hence +1.
      expect(SESSION_CLOCK_TOLERANCE).toBe(MAX_CLOCK_SKEW_SECONDS + 1);
    });
  });

  describe("signToken / verifyToken round trip", () => {
    it("verifies a freshly signed token and returns its claims", () => {
      const token = signToken("user-42");
      const claims = verifyToken(token) as { sub: string; iat: number; exp: number };
      expect(claims.sub).toBe("user-42");
      expect(claims.iat).toBe(NOW_SECONDS);
      expect(claims.exp).toBe(NOW_SECONDS + 60 * 60);
    });

    it("signs with HS256 and a payload carrying only sub/iat/exp", () => {
      const decoded = jwt.decode(signToken("user-7"), { complete: true });
      expect(decoded?.header.alg).toBe("HS256");
      expect(Object.keys(decoded?.payload as object).sort()).toEqual([
        "exp",
        "iat",
        "sub",
      ]);
    });

    it("preserves extra claims such as role on verification", () => {
      const token = jwt.sign({ sub: "admin-1", role: "admin" }, SECRET, {
        algorithm: "HS256",
        expiresIn: 3600,
      });
      expect(verifyToken(token)).toMatchObject({ sub: "admin-1", role: "admin" });
    });
  });

  describe("rejection", () => {
    it("rejects a token whose payload was tampered with", () => {
      const [header, , signature] = signToken("user-42").split(".");
      const forgedPayload = base64UrlJson({
        sub: "admin-1",
        iat: NOW_SECONDS,
        exp: NOW_SECONDS + 3600,
      });
      expect(() => verifyToken(`${header}.${forgedPayload}.${signature}`)).toThrow(
        jwt.JsonWebTokenError
      );
    });

    it("rejects a token whose signature was tampered with", () => {
      const [header, payload, signature] = signToken("user-42").split(".");
      const flipped = (signature[0] === "A" ? "B" : "A") + signature.slice(1);
      expect(() => verifyToken(`${header}.${payload}.${flipped}`)).toThrow(
        jwt.JsonWebTokenError
      );
    });

    it("rejects a token signed with a different secret", () => {
      const token = tokenExpiringAt(NOW_SECONDS + 600, "not-the-real-secret");
      expect(() => verifyToken(token)).toThrow(jwt.JsonWebTokenError);
    });

    it("rejects an unsigned (alg: none) token", () => {
      const token = jwt.sign({ sub: "user-42" }, "", {
        algorithm: "none",
        expiresIn: 3600,
      });
      expect(() => verifyToken(token)).toThrow(jwt.JsonWebTokenError);
    });

    it("rejects a token signed with a non-HS256 algorithm", () => {
      const token = jwt.sign({ sub: "user-42" }, SECRET, {
        algorithm: "HS512",
        expiresIn: 3600,
      });
      expect(() => verifyToken(token)).toThrow(jwt.JsonWebTokenError);
    });

    it.each(["", "garbage", "a.b.c", "not.a.jwt.at.all"])(
      "rejects the malformed token %j",
      (bad) => {
        expect(() => verifyToken(bad)).toThrow(jwt.JsonWebTokenError);
      }
    );
  });

  describe("clock-skew boundary", () => {
    it("accepts a token that has not expired yet", () => {
      expect(verifyToken(tokenExpiringAt(NOW_SECONDS + 600)).sub).toBe("user-42");
    });

    it("accepts a token 59s past expiry", () => {
      expect(verifyToken(tokenExpiringAt(NOW_SECONDS - 59)).sub).toBe("user-42");
    });

    it("accepts a token exactly 60s past expiry", () => {
      expect(verifyToken(tokenExpiringAt(NOW_SECONDS - 60)).sub).toBe("user-42");
    });

    it("accepts a token exactly 60s past expiry late within that second", () => {
      vi.setSystemTime(NOW_SECONDS * 1000 + 999);
      expect(verifyToken(tokenExpiringAt(NOW_SECONDS - 60)).sub).toBe("user-42");
    });

    it("rejects a token 61s past expiry", () => {
      expect(() => verifyToken(tokenExpiringAt(NOW_SECONDS - 61))).toThrow(
        jwt.TokenExpiredError
      );
    });

    it("rejects a token 2 hours past expiry", () => {
      expect(() => verifyToken(tokenExpiringAt(NOW_SECONDS - 2 * 60 * 60))).toThrow(
        jwt.TokenExpiredError
      );
    });

    it("rejects a token 24 hours past expiry (old tolerance must not return)", () => {
      expect(() => verifyToken(tokenExpiringAt(NOW_SECONDS - 24 * 60 * 60))).toThrow(
        jwt.TokenExpiredError
      );
    });

    it("rejects a signToken token once its TTL plus 61s has elapsed", () => {
      const token = signToken("user-42");
      vi.setSystemTime((NOW_SECONDS + 3600 + 60) * 1000);
      expect(verifyToken(token).sub).toBe("user-42");
      vi.setSystemTime((NOW_SECONDS + 3600 + 61) * 1000);
      expect(() => verifyToken(token)).toThrow(jwt.TokenExpiredError);
    });
  });

  describe("re-exports from src/auth", () => {
    it("exposes the very same functions and constants", () => {
      expect(auth.signToken).toBe(jwtUtils.signToken);
      expect(auth.verifyToken).toBe(jwtUtils.verifyToken);
      expect(auth.MAX_CLOCK_SKEW_SECONDS).toBe(jwtUtils.MAX_CLOCK_SKEW_SECONDS);
      expect(auth.SESSION_CLOCK_TOLERANCE).toBe(jwtUtils.SESSION_CLOCK_TOLERANCE);
    });

    it("interoperates: tokens signed via auth verify via utils/jwt and vice versa", () => {
      expect(jwtUtils.verifyToken(auth.signToken("user-1")).sub).toBe("user-1");
      expect(auth.verifyToken(jwtUtils.signToken("user-2")).sub).toBe("user-2");
    });
  });
});
