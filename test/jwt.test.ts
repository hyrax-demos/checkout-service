import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import jwt from "jsonwebtoken";
import { signToken, verifyToken } from "../src/utils/jwt";
import { tokenExpiredSecondsAgo } from "./helpers/token";

// Direct coverage of the consolidated session-token module. The clock-skew
// boundary is also exercised through src/auth.ts and the authenticate
// middleware in test/clock-skew.test.ts; that overlap is intentional.

// Freeze the clock so the boundary cases are deterministic to the second.
const NOW_SECONDS = 1_700_000_000;

describe("src/utils/jwt", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_SECONDS * 1000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("signToken", () => {
    it("round-trips through verifyToken with the expected payload", () => {
      const token = signToken("user-42");
      const claims = verifyToken(token) as { sub: string; iat: number; exp: number };
      expect(claims.sub).toBe("user-42");
      expect(claims.iat).toBe(NOW_SECONDS);
      expect(claims.exp).toBe(NOW_SECONDS + 60 * 60);
    });

    it("signs with HS256", () => {
      const decoded = jwt.decode(signToken("user-42"), { complete: true });
      expect(decoded?.header.alg).toBe("HS256");
    });
  });

  describe("verifyToken clock-skew tolerance", () => {
    it.each([61, 90, 60 * 60, 60 * 60 * 23])(
      "rejects a token that expired %i seconds ago",
      (secondsAgo) => {
        const token = tokenExpiredSecondsAgo(secondsAgo, { now: NOW_SECONDS });
        expect(() => verifyToken(token)).toThrow(jwt.TokenExpiredError);
      }
    );

    it.each([1, 30, 59])(
      "accepts a token that expired %i seconds ago",
      (secondsAgo) => {
        const token = tokenExpiredSecondsAgo(secondsAgo, { now: NOW_SECONDS });
        expect(verifyToken(token).sub).toBe("user-skew");
      }
    );

    it("accepts a token that expired exactly 60 seconds ago", () => {
      const token = tokenExpiredSecondsAgo(60, { now: NOW_SECONDS });
      expect(verifyToken(token).sub).toBe("user-skew");
    });

    it("rejects a token that expired 60.5 seconds ago", () => {
      const token = tokenExpiredSecondsAgo(60.5, { now: NOW_SECONDS });
      expect(() => verifyToken(token)).toThrow(jwt.TokenExpiredError);
    });

    it.each([-1, -60, -3600])(
      "accepts a token that is not yet expired (exp in %i seconds ago)",
      (secondsAgo) => {
        const token = tokenExpiredSecondsAgo(secondsAgo, { now: NOW_SECONDS });
        expect(verifyToken(token).sub).toBe("user-skew");
      }
    );
  });

  describe("verifyToken rejects invalid tokens", () => {
    it("rejects a token signed with the wrong secret", () => {
      const bad = jwt.sign({ sub: "user-42" }, "not-the-real-secret", {
        algorithm: "HS256",
        expiresIn: 3600,
      });
      expect(() => verifyToken(bad)).toThrow(jwt.JsonWebTokenError);
    });

    it("rejects a token whose signature has been tampered with", () => {
      const [header, payload, signature] = signToken("user-42").split(".");
      const flipped = (signature[0] === "A" ? "B" : "A") + signature.slice(1);
      expect(() => verifyToken(`${header}.${payload}.${flipped}`)).toThrow(
        jwt.JsonWebTokenError
      );
    });

    it("rejects a token whose payload has been altered", () => {
      const [header, , signature] = signToken("user-42").split(".");
      const forged = Buffer.from(
        JSON.stringify({ sub: "admin", exp: NOW_SECONDS + 3600 })
      ).toString("base64url");
      expect(() => verifyToken(`${header}.${forged}.${signature}`)).toThrow(
        jwt.JsonWebTokenError
      );
    });

    it("rejects a token signed with a non-HS256 algorithm", () => {
      const hs512 = jwt.sign({ sub: "user-42" }, process.env.JWT_SECRET as string, {
        algorithm: "HS512",
        expiresIn: 3600,
      });
      expect(() => verifyToken(hs512)).toThrow(jwt.JsonWebTokenError);
    });

    it("rejects an unsigned (alg: none) token", () => {
      const unsigned = jwt.sign({ sub: "user-42" }, "", {
        algorithm: "none",
        expiresIn: 3600,
      });
      expect(() => verifyToken(unsigned)).toThrow(jwt.JsonWebTokenError);
    });

    it.each(["", "not-a-jwt", "a.b", "a.b.c"])(
      "rejects malformed token %j",
      (token) => {
        expect(() => verifyToken(token)).toThrow(jwt.JsonWebTokenError);
      }
    );
  });
});
