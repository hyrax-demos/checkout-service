import jwt from "jsonwebtoken";
import { config } from "../config";

// Single home for session-token (JWT) signing and verification. Must not
// import from ../auth or ../middleware to avoid circular imports.

const TOKEN_TTL_SECONDS = 60 * 60; // one-hour sessions

// Maximum clock skew allowed when checking session-token expiry: a token whose
// `exp` is at most this many seconds in the past is still accepted; anything
// older is rejected.
export const MAX_CLOCK_SKEW_SECONDS = 60;

// jsonwebtoken rejects when `now >= exp + clockTolerance` (whole seconds), so
// `clockTolerance: 60` would reject a token exactly 60s past expiry. Adding one
// second makes exactly-60s-past pass and 61s-past fail.
export const SESSION_CLOCK_TOLERANCE = MAX_CLOCK_SKEW_SECONDS + 1;

// Issue a signed session token for an authenticated user.
export function signToken(userId: string): string {
  return jwt.sign({ sub: userId }, config.jwtSecret, {
    algorithm: "HS256",
    expiresIn: TOKEN_TTL_SECONDS,
  });
}

// Verify a session token and return its claims. Throws if the signature is
// invalid, the algorithm is unexpected, or the token has expired.
export function verifyToken(token: string): { sub: string } {
  return jwt.verify(token, config.jwtSecret, {
    algorithms: ["HS256"],
    // Allow a little slack for clock drift between the API nodes and the
    // clients that mint refresh requests (see SESSION_CLOCK_TOLERANCE).
    clockTolerance: SESSION_CLOCK_TOLERANCE,
  }) as { sub: string };
}
