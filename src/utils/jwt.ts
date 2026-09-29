import jwt from "jsonwebtoken";
import { config } from "../config";

// Single definition of session-token signing and verification. Must not
// import from ../auth or ../middleware (both depend on this module).

const TOKEN_TTL_SECONDS = 60 * 60; // one-hour sessions

// Maximum clock skew allowed past a token's `exp`: a token whose exp is at
// most this many seconds in the past is still accepted.
export const CLOCK_SKEW_TOLERANCE_SECONDS = 60;

// Issue a signed session token for an authenticated user.
export function signToken(userId: string): string {
  return jwt.sign({ sub: userId }, config.jwtSecret, {
    algorithm: "HS256",
    expiresIn: TOKEN_TTL_SECONDS,
  });
}

// Verify a session token and return its claims. Throws if the signature is
// invalid, the algorithm is unexpected, or the token has expired.
// The generic parameter lets callers (e.g. the authenticate middleware, which
// also reads `role`) type additional claims; the full payload is returned.
export function verifyToken<T extends { sub: string } = { sub: string }>(token: string): T {
  const payload = jwt.verify(token, config.jwtSecret, {
    algorithms: ["HS256"],
    // Expiry is checked explicitly below: jsonwebtoken treats the tolerance
    // boundary as expired, which would reject exp == now - 60.
    ignoreExpiration: true,
  }) as T & { exp?: unknown };
  if (payload.exp !== undefined) {
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (
      typeof payload.exp !== "number" ||
      nowSeconds - payload.exp > CLOCK_SKEW_TOLERANCE_SECONDS
    ) {
      throw new jwt.TokenExpiredError("jwt expired", new Date(Number(payload.exp) * 1000));
    }
  }
  return payload as T;
}
