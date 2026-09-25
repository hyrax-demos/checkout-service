import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import jwt from "jsonwebtoken";
import {
  signToken,
  verifyToken,
  MAX_CLOCK_SKEW_SECONDS,
  JWT_CLOCK_TOLERANCE_SECONDS,
} from "../src/utils/jwt";
import * as auth from "../src/auth";

// Direct tests for the session-token module. The secret comes from
// `test/setup.ts` (JWT_SECRET), the same way every other suite gets it.

// Pinned wall clock (whole seconds) so iat/exp and the skew boundary are
// deterministic. jsonwebtoken reads `Date.now()` for both signing and
// verifying, so faking Date is enough — no real sleeps.
const NOW_SECONDS = 1_700_000_000;
const TOKEN_TTL_SECONDS = 60 * 60;

function setClock(seconds: number): void {
  vi.setSystemTime(seconds * 1000);
}

// Replace one character in the middle of a base64url segment so the decoded
// bytes definitely change (the final character can carry only padding bits).
function flipCharAt(segment: string, index: number): string {
  const c = segment[index];
  const replacement = c === "A" ? "B" : "A";
  return segment.slice(0, index) + replacement + segment.slice(index + 1);
}

function b64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

describe("src/utils/jwt", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    setClock(NOW_SECONDS);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("round-trip", () => {
    it("verifyToken accepts a token from signToken and returns its claims", () => {
      const token = signToken("user-42");
      const claims = verifyToken(token) as unknown as Record<string, unknown>;
      expect(claims.sub).toBe("user-42");
      expect(claims.iat).toBe(NOW_SECONDS);
      expect(claims.exp).toBe(NOW_SECONDS + TOKEN_TTL_SECONDS);
    });

    it("signs with HS256", () => {
      const decoded = jwt.decode(signToken("user-42"), { complete: true });
      expect(decoded?.header.alg).toBe("HS256");
    });
  });

  describe("integrity", () => {
    it("rejects a token whose payload was modified", () => {
      const [header, , signature] = signToken("user-42").split(".");
      const forgedPayload = b64url({
        sub: "admin",
        iat: NOW_SECONDS,
        exp: NOW_SECONDS + TOKEN_TTL_SECONDS,
      });
      const forged = `${header}.${forgedPayload}.${signature}`;
      expect(() => verifyToken(forged)).toThrow(jwt.JsonWebTokenError);
    });

    it("rejects a token whose signature was modified", () => {
      const [header, payload, signature] = signToken("user-42").split(".");
      const tampered = `${header}.${payload}.${flipCharAt(signature, 5)}`;
      expect(() => verifyToken(tampered)).toThrow(jwt.JsonWebTokenError);
    });

    it("rejects a token signed with a different secret", () => {
      const other = jwt.sign({ sub: "user-42" }, "not-the-real-secret", {
        algorithm: "HS256",
        expiresIn: TOKEN_TTL_SECONDS,
      });
      expect(() => verifyToken(other)).toThrow(jwt.JsonWebTokenError);
    });

    it("rejects an unsigned (alg: none) token", () => {
      const unsigned = `${b64url({ alg: "none", typ: "JWT" })}.${b64url({
        sub: "user-42",
        exp: NOW_SECONDS + TOKEN_TTL_SECONDS,
      })}.`;
      expect(() => verifyToken(unsigned)).toThrow(jwt.JsonWebTokenError);
    });
  });

  describe("malformed input", () => {
    for (const [label, token] of [
      ["an empty string", ""],
      ["a non-JWT string", "not-a-jwt"],
      ["a token with too few segments", "abc.def"],
      ["garbage segments", "!!!.@@@.###"],
    ] as const) {
      it(`rejects ${label}`, () => {
        expect(() => verifyToken(token)).toThrow(jwt.JsonWebTokenError);
      });
    }
  });

  describe("clock-skew boundary", () => {
    const cases: Array<{ label: string; secondsAgo: number; accepted: boolean }> = [
      { label: "expired 0s ago", secondsAgo: 0, accepted: true },
      { label: "expired 30s ago", secondsAgo: 30, accepted: true },
      { label: "expired exactly 60s ago", secondsAgo: 60, accepted: true },
      { label: "expired 61s ago", secondsAgo: 61, accepted: false },
      { label: "expired 1 hour ago", secondsAgo: 60 * 60, accepted: false },
    ];

    for (const { label, secondsAgo, accepted } of cases) {
      it(`${accepted ? "accepts" : "rejects"} a token ${label}`, () => {
        // Sign at the pinned clock, then move the clock past `exp`.
        const token = signToken("user-42");
        const exp = NOW_SECONDS + TOKEN_TTL_SECONDS;
        setClock(exp + secondsAgo);
        if (accepted) {
          expect(verifyToken(token).sub).toBe("user-42");
        } else {
          expect(() => verifyToken(token)).toThrow(jwt.TokenExpiredError);
        }
      });
    }
  });

  describe("skew constants", () => {
    it("MAX_CLOCK_SKEW_SECONDS is the documented 60-second boundary", () => {
      expect(MAX_CLOCK_SKEW_SECONDS).toBe(60);
    });

    it("JWT_CLOCK_TOLERANCE_SECONDS compensates for jsonwebtoken's >= check", () => {
      expect(JWT_CLOCK_TOLERANCE_SECONDS).toBe(MAX_CLOCK_SKEW_SECONDS + 1);
    });
  });

  describe("re-export from src/auth", () => {
    it("exposes the same functions and constants", () => {
      expect(auth.signToken).toBe(signToken);
      expect(auth.verifyToken).toBe(verifyToken);
      expect(auth.MAX_CLOCK_SKEW_SECONDS).toBe(MAX_CLOCK_SKEW_SECONDS);
      expect(auth.JWT_CLOCK_TOLERANCE_SECONDS).toBe(JWT_CLOCK_TOLERANCE_SECONDS);
    });

    it("tokens are interchangeable between the two import paths", () => {
      expect(auth.verifyToken(signToken("user-7")).sub).toBe("user-7");
      expect(verifyToken(auth.signToken("user-8")).sub).toBe("user-8");
    });
  });
});
