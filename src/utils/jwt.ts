import jwt from "jsonwebtoken";
import { config } from "../config";

// Single definition of session-token signing and verification. `src/auth.ts`
// re-exports these for existing import sites, and the `authenticate`
// middleware verifies bearer tokens through `verifyToken`.

const TOKEN_TTL_SECONDS = 60 * 60; // one-hour sessions

// Maximum clock skew allowed when checking a session token's expiry: a token
// whose `exp` is at most this many seconds in the past is still accepted
// (including exactly exp + 60); anything older is rejected.
export const MAX_CLOCK_SKEW_SECONDS = 60;

// `jsonwebtoken` rejects when `now >= exp + clockTolerance` (whole seconds), so
// a tolerance of exactly MAX_CLOCK_SKEW_SECONDS would reject at exp + 60. Add
// one so the token is accepted at exp + 60 and rejected at exp + 61.
export const JWT_CLOCK_TOLERANCE_SECONDS = MAX_CLOCK_SKEW_SECONDS + 1;

// Claims carried by a session token. `role` is optional and only present on
// tokens issued to privileged users.
export interface SessionClaims {
  sub: string;
  role?: string;
}

// Issue a signed session token for an authenticated user.
export function signToken(userId: string): string {
  return jwt.sign({ sub: userId }, config.jwtSecret, {
    algorithm: "HS256",
    expiresIn: TOKEN_TTL_SECONDS,
  });
}

// Verify a session token and return its claims. Throws if the signature is
// invalid, the algorithm is unexpected, or the token has expired.
export function verifyToken(token: string): SessionClaims {
  return jwt.verify(token, config.jwtSecret, {
    algorithms: ["HS256"],
    // Allow a little slack for clock drift between the API nodes and the
    // clients that mint refresh requests.
    clockTolerance: JWT_CLOCK_TOLERANCE_SECONDS,
  }) as SessionClaims;
}
