import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import jwt from "jsonwebtoken";
import {
  signToken,
  verifyToken,
  MAX_CLOCK_SKEW_SECONDS,
  JWT_CLOCK_TOLERANCE_SECONDS,
} from "../src/utils/jwt";
import * as auth from "../src/auth";

const SECRET = process.env.JWT_SECRET as string;

// Pinned "now" (whole seconds) so expiry boundaries are exact.
const NOW_SECONDS = 1_700_000_000;

function tokenWithExp(exp: number, secret: string = SECRET): string {
  return jwt.sign({ sub: "user-42", iat: exp - 3600, exp }, secret, {
    algorithm: "HS256",
  });
}

function tokenExpiredSecondsAgo(secondsAgo: number): string {
  return tokenWithExp(NOW_SECONDS - secondsAgo);
}

function b64url(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW_SECONDS * 1000);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("utils/jwt skew constants", () => {
  it("allows at most 60 seconds of clock skew", () => {
    expect(MAX_CLOCK_SKEW_SECONDS).toBe(60);
  });

  it("passes skew + 1 to jsonwebtoken to make the 60s boundary inclusive", () => {
    expect(JWT_CLOCK_TOLERANCE_SECONDS).toBe(MAX_CLOCK_SKEW_SECONDS + 1);
  });
});

describe("utils/jwt signToken / verifyToken round-trip", () => {
  it("returns the signed subject and standard claims", () => {
    const claims = verifyToken(signToken("user-42")) as ReturnType<
      typeof verifyToken
    > & { iat: number; exp: number };
    expect(claims.sub).toBe("user-42");
    expect(claims.iat).toBe(NOW_SECONDS);
    expect(claims.exp).toBe(NOW_SECONDS + 60 * 60);
  });

  it("signs with HS256", () => {
    const decoded = jwt.decode(signToken("user-42"), { complete: true });
    expect(decoded?.header.alg).toBe("HS256");
  });

  it("returns the optional role claim when present", () => {
    const token = jwt.sign({ sub: "admin-1", role: "admin" }, SECRET, {
      algorithm: "HS256",
      expiresIn: 3600,
    });
    expect(verifyToken(token)).toMatchObject({ sub: "admin-1", role: "admin" });
  });
});

describe("utils/jwt tamper rejection", () => {
  it("rejects a token signed with a different secret", () => {
    const bad = tokenWithExp(NOW_SECONDS + 3600, "not-the-real-secret");
    expect(() => verifyToken(bad)).toThrow(jwt.JsonWebTokenError);
  });

  it("rejects a token whose payload was modified", () => {
    const [header, , signature] = signToken("user-42").split(".");
    const forgedPayload = b64url({
      sub: "admin-1",
      iat: NOW_SECONDS,
      exp: NOW_SECONDS + 3600,
    });
    expect(() =>
      verifyToken(`${header}.${forgedPayload}.${signature}`)
    ).toThrow(jwt.JsonWebTokenError);
  });

  it("rejects a token whose signature was modified", () => {
    const [header, payload, signature] = signToken("user-42").split(".");
    const flipped =
      (signature[0] === "A" ? "B" : "A") + signature.slice(1);
    expect(() => verifyToken(`${header}.${payload}.${flipped}`)).toThrow(
      jwt.JsonWebTokenError
    );
  });

  it("rejects a token with the signature stripped", () => {
    const [header, payload] = signToken("user-42").split(".");
    expect(() => verifyToken(`${header}.${payload}.`)).toThrow(
      jwt.JsonWebTokenError
    );
  });

  it("rejects an unsigned alg=none token", () => {
    const token = `${b64url({ alg: "none", typ: "JWT" })}.${b64url({
      sub: "user-42",
      exp: NOW_SECONDS + 3600,
    })}.`;
    expect(() => verifyToken(token)).toThrow(jwt.JsonWebTokenError);
  });

  it("rejects a token signed with an algorithm other than HS256", () => {
    const token = jwt.sign({ sub: "user-42" }, SECRET, {
      algorithm: "HS512",
      expiresIn: 3600,
    });
    expect(() => verifyToken(token)).toThrow(jwt.JsonWebTokenError);
  });
});

describe("utils/jwt malformed input", () => {
  it.each([
    ["empty string", ""],
    ["garbage", "not-a-jwt"],
    ["three garbage segments", "a.b.c"],
    ["too many segments", "a.b.c.d"],
  ])("throws on %s", (_label, input) => {
    expect(() => verifyToken(input)).toThrow(jwt.JsonWebTokenError);
  });
});

describe("utils/jwt clock-skew tolerance", () => {
  it("accepts a token that has not yet expired", () => {
    expect(verifyToken(tokenWithExp(NOW_SECONDS + 600)).sub).toBe("user-42");
  });

  it("accepts a token that expired 1s ago", () => {
    expect(verifyToken(tokenExpiredSecondsAgo(1)).sub).toBe("user-42");
  });

  it("accepts a token that expired exactly 60s ago", () => {
    expect(verifyToken(tokenExpiredSecondsAgo(60)).sub).toBe("user-42");
  });

  it("accepts a token that expired exactly 60s ago, late in that second", () => {
    vi.setSystemTime(NOW_SECONDS * 1000 + 999);
    expect(verifyToken(tokenExpiredSecondsAgo(60)).sub).toBe("user-42");
  });

  it("rejects a token that expired 61s ago", () => {
    expect(() => verifyToken(tokenExpiredSecondsAgo(61))).toThrow(
      jwt.TokenExpiredError
    );
  });

  it("rejects a token that expired 24 hours ago", () => {
    expect(() => verifyToken(tokenExpiredSecondsAgo(60 * 60 * 24))).toThrow(
      jwt.TokenExpiredError
    );
  });

  it("accepts a freshly signed token up to 60s past its TTL, then rejects it", () => {
    const token = signToken("user-42");
    vi.setSystemTime((NOW_SECONDS + 3600 + 60) * 1000);
    expect(verifyToken(token).sub).toBe("user-42");
    vi.setSystemTime((NOW_SECONDS + 3600 + 61) * 1000);
    expect(() => verifyToken(token)).toThrow(jwt.TokenExpiredError);
  });
});

describe("src/auth re-exports", () => {
  it("re-exports the same functions and constants as src/utils/jwt", () => {
    expect(auth.signToken).toBe(signToken);
    expect(auth.verifyToken).toBe(verifyToken);
    expect(auth.MAX_CLOCK_SKEW_SECONDS).toBe(MAX_CLOCK_SKEW_SECONDS);
    expect(auth.JWT_CLOCK_TOLERANCE_SECONDS).toBe(JWT_CLOCK_TOLERANCE_SECONDS);
  });

  it("tokens are interchangeable between the two import paths", () => {
    expect(verifyToken(auth.signToken("user-42")).sub).toBe("user-42");
    expect(auth.verifyToken(signToken("user-42")).sub).toBe("user-42");
  });
});
