// Session-token signing and verification. This is the single place where
// session tokens are minted and checked; `src/auth.ts` re-exports these
// helpers and `src/middleware/authenticate.ts` calls `verifyToken`.
//
// Must not import from `src/auth.ts` or the middleware (avoids import cycles).
import jwt from "jsonwebtoken";
import { config } from "../config";

const TOKEN_TTL_SECONDS = 60 * 60; // one-hour sessions

// Maximum clock skew allowed when checking a session token's expiry: a token
// whose `exp` is at most this many seconds in the past is still accepted.
export const MAX_CLOCK_SKEW_SECONDS = 60;

// Value passed to jsonwebtoken's `clockTolerance`. jsonwebtoken compares whole
// seconds and rejects when `clockTimestamp >= exp + clockTolerance`, so a raw
// tolerance of 60 would REJECT a token that expired exactly 60s ago. Adding 1
// gives the required boundary: expired 60s ago -> accepted, 61s -> rejected.
export const JWT_CLOCK_TOLERANCE_SECONDS = MAX_CLOCK_SKEW_SECONDS + 1;

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
    // clients that mint refresh requests (at most MAX_CLOCK_SKEW_SECONDS; see
    // JWT_CLOCK_TOLERANCE_SECONDS for why the value is 60 + 1).
    clockTolerance: JWT_CLOCK_TOLERANCE_SECONDS,
  }) as { sub: string };
}
