import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import jwt from "jsonwebtoken";
import {
  signToken,
  verifyToken,
  MAX_CLOCK_SKEW_SECONDS,
} from "../src/utils/jwt";
import * as auth from "../src/auth";

// The signing secret comes from `test/setup.ts` (JWT_SECRET), exactly as for
// the other auth tests. Only `Date` is faked so "now" is frozen between
// signing and verifying, which makes the second-level boundaries
// deterministic without sleeping.
const SECRET = process.env.JWT_SECRET as string;
const NOW_SECONDS = 1_700_000_000;

function sign(payload: Record<string, unknown>, options: jwt.SignOptions = {}) {
  return jwt.sign(payload, SECRET, { algorithm: "HS256", ...options });
}

function tokenWithExp(exp: number): string {
  return sign({ sub: "user-42", iat: exp - 3600, exp });
}

function caughtError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error("expected function to throw");
}

describe("src/utils/jwt", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW_SECONDS * 1000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("MAX_CLOCK_SKEW_SECONDS", () => {
    it("is 60 seconds", () => {
      expect(MAX_CLOCK_SKEW_SECONDS).toBe(60);
    });
  });

  describe("round trip", () => {
    it("verifies a token produced by signToken and returns its claims", () => {
      const token = signToken("user-42");
      const claims = verifyToken(token) as {
        sub: string;
        iat?: number;
        exp?: number;
      };
      expect(claims.sub).toBe("user-42");
      expect(claims.iat).toBe(NOW_SECONDS);
      expect(claims.exp).toBe(NOW_SECONDS + 3600);
    });

    it("signs with HS256", () => {
      const decoded = jwt.decode(signToken("user-42"), { complete: true });
      expect(decoded?.header.alg).toBe("HS256");
    });
  });

  describe("tampering", () => {
    it("rejects a token whose payload was modified", () => {
      const [header, , signature] = signToken("user-42").split(".");
      const forgedPayload = Buffer.from(
        JSON.stringify({ sub: "admin", exp: NOW_SECONDS + 3600 })
      ).toString("base64url");
      const forged = `${header}.${forgedPayload}.${signature}`;
      const err = caughtError(() => verifyToken(forged));
      expect(err).toBeInstanceOf(jwt.JsonWebTokenError);
      expect((err as Error).message).toBe("invalid signature");
    });

    it("rejects a token whose signature was modified", () => {
      const [header, payload, signature] = signToken("user-42").split(".");
      const flipped = (signature[0] === "A" ? "B" : "A") + signature.slice(1);
      const forged = `${header}.${payload}.${flipped}`;
      expect(() => verifyToken(forged)).toThrow(jwt.JsonWebTokenError);
    });

    it("rejects a token with the signature stripped", () => {
      const [header, payload] = signToken("user-42").split(".");
      expect(() => verifyToken(`${header}.${payload}.`)).toThrow(
        jwt.JsonWebTokenError
      );
    });
  });

  describe("wrong secret / algorithm", () => {
    it("rejects a token signed with a different secret", () => {
      const bad = jwt.sign({ sub: "user-42" }, "not-the-real-secret", {
        algorithm: "HS256",
        expiresIn: 3600,
      });
      const err = caughtError(() => verifyToken(bad));
      expect(err).toBeInstanceOf(jwt.JsonWebTokenError);
      expect((err as Error).message).toBe("invalid signature");
    });

    it("rejects a token signed with a non-pinned algorithm (HS512)", () => {
      const bad = sign({ sub: "user-42" }, { algorithm: "HS512", expiresIn: 3600 });
      const err = caughtError(() => verifyToken(bad));
      expect(err).toBeInstanceOf(jwt.JsonWebTokenError);
      expect((err as Error).message).toBe("invalid algorithm");
    });

    it("rejects an unsigned alg=none token", () => {
      const unsigned = jwt.sign({ sub: "user-42" }, "", { algorithm: "none" });
      expect(() => verifyToken(unsigned)).toThrow(jwt.JsonWebTokenError);
    });
  });

  describe("garbage input", () => {
    it.each(["", "not-a-jwt", "a.b.c", "...", "Bearer x.y.z"])(
      "rejects %j",
      (input) => {
        expect(() => verifyToken(input)).toThrow(jwt.JsonWebTokenError);
      }
    );
  });

  describe("exp clock-skew boundaries", () => {
    it("accepts a token that expires in the future", () => {
      expect(verifyToken(tokenWithExp(NOW_SECONDS + 3600)).sub).toBe("user-42");
    });

    it("accepts a token that expired exactly now", () => {
      expect(verifyToken(tokenWithExp(NOW_SECONDS)).sub).toBe("user-42");
    });

    it("accepts a token that expired exactly 60 seconds ago", () => {
      expect(verifyToken(tokenWithExp(NOW_SECONDS - 60)).sub).toBe("user-42");
    });

    it.each([61, 3600])(
      "rejects a token that expired %i seconds ago with TokenExpiredError",
      (ageSeconds) => {
        const exp = NOW_SECONDS - ageSeconds;
        const err = caughtError(() => verifyToken(tokenWithExp(exp)));
        expect(err).toBeInstanceOf(jwt.TokenExpiredError);
        expect((err as Error).name).toBe("TokenExpiredError");
        expect((err as Error).message).toBe("jwt expired");
        expect((err as jwt.TokenExpiredError).expiredAt).toEqual(
          new Date(exp * 1000)
        );
      }
    );

    it("rejects a token from signToken once it is more than 60s past expiry", () => {
      const token = signToken("user-42");
      vi.setSystemTime((NOW_SECONDS + 3600 + 60) * 1000);
      expect(verifyToken(token).sub).toBe("user-42");
      vi.setSystemTime((NOW_SECONDS + 3600 + 61) * 1000);
      expect(() => verifyToken(token)).toThrow(jwt.TokenExpiredError);
    });

    it("keeps accepting a token with no exp claim", () => {
      expect(verifyToken(sign({ sub: "user-42" })).sub).toBe("user-42");
    });
  });

  describe("nbf clock-skew boundaries", () => {
    function tokenWithNbf(nbf: number): string {
      return sign({ sub: "user-42", nbf, exp: NOW_SECONDS + 3600 });
    }

    it("accepts a token whose nbf is 60 seconds in the future", () => {
      expect(verifyToken(tokenWithNbf(NOW_SECONDS + 60)).sub).toBe("user-42");
    });

    it.each([61, 3600])(
      "rejects a token whose nbf is %i seconds in the future",
      (aheadSeconds) => {
        const err = caughtError(() =>
          verifyToken(tokenWithNbf(NOW_SECONDS + aheadSeconds))
        );
        expect(err).toBeInstanceOf(jwt.NotBeforeError);
        expect((err as Error).name).toBe("NotBeforeError");
      }
    );
  });

  describe("backward-compatible re-export from src/auth", () => {
    it("re-exports the very same functions", () => {
      expect(auth.signToken).toBe(signToken);
      expect(auth.verifyToken).toBe(verifyToken);
    });

    it("round-trips across the two import paths", () => {
      expect(verifyToken(auth.signToken("user-7")).sub).toBe("user-7");
      expect(auth.verifyToken(signToken("user-8")).sub).toBe("user-8");
    });
  });
});
