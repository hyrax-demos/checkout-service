import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import jwt from "jsonwebtoken";
import {
  signToken,
  verifyToken,
  MAX_CLOCK_SKEW_SECONDS,
  JWT_CLOCK_TOLERANCE_SECONDS,
} from "../src/utils/jwt";
import * as auth from "../src/auth";

// JWT_SECRET is provided by test/setup.ts.
const SECRET = process.env.JWT_SECRET as string;

// Fixed "now" (whole seconds) so expiry boundaries are deterministic.
const NOW_SEC = 1_700_000_000;

function tokenExpiringAt(exp: number): string {
  return jwt.sign({ sub: "user-42", iat: exp - 3600, exp }, SECRET, {
    algorithm: "HS256",
  });
}

describe("src/utils/jwt", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW_SEC * 1000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("round trip", () => {
    it("verifyToken accepts signToken output and returns the signed claims", () => {
      const token = signToken("user-42");
      const claims = verifyToken(token) as jwt.JwtPayload;
      expect(claims.sub).toBe("user-42");
      expect(claims.iat).toBe(NOW_SEC);
      expect(claims.exp).toBe(NOW_SEC + 3600);
    });

    it("signs with HS256", () => {
      const decoded = jwt.decode(signToken("user-42"), { complete: true });
      expect(decoded?.header.alg).toBe("HS256");
    });
  });

  describe("clock-skew boundary", () => {
    it("allows at most 60 seconds of skew", () => {
      expect(MAX_CLOCK_SKEW_SECONDS).toBe(60);
      expect(JWT_CLOCK_TOLERANCE_SECONDS).toBe(MAX_CLOCK_SKEW_SECONDS + 1);
    });

    it("accepts a token whose exp is in the future", () => {
      expect(verifyToken(tokenExpiringAt(NOW_SEC + 600)).sub).toBe("user-42");
    });

    it("accepts a token at exp + 30s", () => {
      expect(verifyToken(tokenExpiringAt(NOW_SEC - 30)).sub).toBe("user-42");
    });

    it("accepts a token at exactly exp + 60s", () => {
      expect(verifyToken(tokenExpiringAt(NOW_SEC - 60)).sub).toBe("user-42");
    });

    it("accepts at exp + 60s even late within that second", () => {
      vi.setSystemTime(NOW_SEC * 1000 + 999);
      expect(verifyToken(tokenExpiringAt(NOW_SEC - 60)).sub).toBe("user-42");
    });

    it("rejects a token at exp + 61s", () => {
      expect(() => verifyToken(tokenExpiringAt(NOW_SEC - 61))).toThrow(
        jwt.TokenExpiredError
      );
    });

    it("rejects a token hours past exp", () => {
      expect(() => verifyToken(tokenExpiringAt(NOW_SEC - 3 * 3600))).toThrow(
        jwt.TokenExpiredError
      );
    });

    it("rejects a signToken token once the TTL plus 61s has elapsed", () => {
      const token = signToken("user-42");
      vi.setSystemTime((NOW_SEC + 3600 + 60) * 1000);
      expect(verifyToken(token).sub).toBe("user-42");
      vi.setSystemTime((NOW_SEC + 3600 + 61) * 1000);
      expect(() => verifyToken(token)).toThrow(jwt.TokenExpiredError);
    });
  });

  describe("rejection", () => {
    it("rejects a token signed with the wrong secret", () => {
      const bad = jwt.sign({ sub: "user-42" }, "not-the-real-secret", {
        algorithm: "HS256",
        expiresIn: 3600,
      });
      expect(() => verifyToken(bad)).toThrow(jwt.JsonWebTokenError);
    });

    it("rejects a token with a tampered payload", () => {
      const [header, , signature] = signToken("user-42").split(".");
      const forgedPayload = Buffer.from(
        JSON.stringify({ sub: "admin", exp: NOW_SEC + 3600 })
      ).toString("base64url");
      expect(() =>
        verifyToken(`${header}.${forgedPayload}.${signature}`)
      ).toThrow(jwt.JsonWebTokenError);
    });

    it("rejects a token with a tampered signature", () => {
      const token = signToken("user-42");
      const last = token.slice(-1);
      const tampered = token.slice(0, -1) + (last === "A" ? "B" : "A");
      expect(() => verifyToken(tampered)).toThrow(jwt.JsonWebTokenError);
    });

    it("rejects malformed tokens", () => {
      expect(() => verifyToken("not-a-jwt")).toThrow(jwt.JsonWebTokenError);
      expect(() => verifyToken("")).toThrow(jwt.JsonWebTokenError);
    });

    it("rejects an unsigned alg=none token", () => {
      const none = jwt.sign(
        { sub: "user-42", exp: NOW_SEC + 3600 },
        "",
        { algorithm: "none" }
      );
      expect(() => verifyToken(none)).toThrow(jwt.JsonWebTokenError);
    });

    it("rejects a token signed with a disallowed algorithm (HS512)", () => {
      const hs512 = jwt.sign({ sub: "user-42", exp: NOW_SEC + 3600 }, SECRET, {
        algorithm: "HS512",
      });
      expect(() => verifyToken(hs512)).toThrow(jwt.JsonWebTokenError);
    });
  });

  describe("re-export from src/auth", () => {
    it("exposes the same functions and constants", () => {
      expect(auth.signToken).toBe(signToken);
      expect(auth.verifyToken).toBe(verifyToken);
      expect(auth.MAX_CLOCK_SKEW_SECONDS).toBe(MAX_CLOCK_SKEW_SECONDS);
      expect(auth.JWT_CLOCK_TOLERANCE_SECONDS).toBe(
        JWT_CLOCK_TOLERANCE_SECONDS
      );
    });

    it("tokens are interchangeable between the two import paths", () => {
      expect(verifyToken(auth.signToken("user-7")).sub).toBe("user-7");
      expect(auth.verifyToken(signToken("user-8")).sub).toBe("user-8");
    });
  });
});
