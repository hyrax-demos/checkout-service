import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import jwt from "jsonwebtoken";
import {
  signToken,
  verifyToken,
  MAX_CLOCK_SKEW_SECONDS,
} from "../src/utils/jwt";
import * as auth from "../src/auth";

const NOW = 1_700_000_000; // fixed epoch seconds
const SECRET = process.env.JWT_SECRET as string;

function tokenExpiredAgo(seconds: number, secret = SECRET): string {
  return jwt.sign(
    { sub: "user-42", iat: NOW - 3600 - seconds, exp: NOW - seconds },
    secret,
    { algorithm: "HS256" }
  );
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW * 1000);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("src/utils/jwt", () => {
  it("round-trips sign and verify", () => {
    const claims = verifyToken(signToken("user-42")) as jwt.JwtPayload;
    expect(claims.sub).toBe("user-42");
    expect(claims.iat).toBe(NOW);
    expect(claims.exp).toBe(NOW + 3600);
  });

  it("rejects a token with a tampered payload", () => {
    const [h, , s] = signToken("user-42").split(".");
    const forged = Buffer.from(
      JSON.stringify({ sub: "admin", iat: NOW, exp: NOW + 3600 })
    ).toString("base64url");
    expect(() => verifyToken(`${h}.${forged}.${s}`)).toThrow(
      jwt.JsonWebTokenError
    );
  });

  it("rejects a token with a tampered signature", () => {
    const token = signToken("user-42");
    const last = token.slice(-1);
    const tampered = token.slice(0, -1) + (last === "A" ? "B" : "A");
    expect(() => verifyToken(tampered)).toThrow(jwt.JsonWebTokenError);
  });

  it("rejects a token signed with a different secret", () => {
    const token = jwt.sign({ sub: "user-42" }, SECRET + "-other", {
      algorithm: "HS256",
      expiresIn: 3600,
    });
    expect(() => verifyToken(token)).toThrow(jwt.JsonWebTokenError);
  });

  it("rejects malformed input", () => {
    expect(() => verifyToken("not-a-jwt")).toThrow(jwt.JsonWebTokenError);
    expect(() => verifyToken("")).toThrow();
  });

  it("exports a 60s skew constant", () => {
    expect(MAX_CLOCK_SKEW_SECONDS).toBe(60);
  });

  it("accepts a token that is not expired", () => {
    expect(verifyToken(tokenExpiredAgo(-600)).sub).toBe("user-42");
  });

  it("accepts a token expired 30s ago", () => {
    expect(verifyToken(tokenExpiredAgo(30)).sub).toBe("user-42");
  });

  it("accepts a token expired exactly 60s ago", () => {
    expect(verifyToken(tokenExpiredAgo(60)).sub).toBe("user-42");
  });

  it("rejects a token expired 61s ago with TokenExpiredError", () => {
    expect(() => verifyToken(tokenExpiredAgo(61))).toThrow(
      jwt.TokenExpiredError
    );
  });

  it("rejects a token expired 24h ago with TokenExpiredError", () => {
    expect(() => verifyToken(tokenExpiredAgo(24 * 60 * 60))).toThrow(
      jwt.TokenExpiredError
    );
  });
});

describe("src/auth backwards compatibility", () => {
  it("re-exports the same functions", () => {
    expect(auth.signToken).toBe(signToken);
    expect(auth.verifyToken).toBe(verifyToken);
  });

  it("interoperates across import paths", () => {
    expect(verifyToken(auth.signToken("u1")).sub).toBe("u1");
    expect(auth.verifyToken(signToken("u2")).sub).toBe("u2");
  });
});
