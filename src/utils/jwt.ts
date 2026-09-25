// Session-token (JWT) signing and verification. This is the single place the
// service calls into the JWT library for session tokens; `src/auth.ts`
// re-exports these for existing import sites and the authenticate middleware
// uses `verifyToken` directly.
import jwt from "jsonwebtoken";
import { config } from "../config";

const TOKEN_TTL_SECONDS = 60 * 60; // one-hour sessions

// Maximum clock skew allowed when verifying a session token: a token whose
// `exp` is at most this many seconds in the past (inclusive) is accepted; one
// that expired longer ago than this is rejected.
export const MAX_CLOCK_SKEW_SECONDS = 60;

// Value to pass as jsonwebtoken's `clockTolerance`. jsonwebtoken (8.x,
// verify.js) treats a token as expired when
// `Math.floor(Date.now() / 1000) >= exp + clockTolerance`, i.e. the boundary
// is exclusive. With whole-second timestamps, passing MAX_CLOCK_SKEW_SECONDS
// would reject a token that expired exactly 60s ago; adding 1 makes the
// library accept `now - exp <= 60` and reject `now - exp >= 61`, which is the
// required inclusive 60-second boundary.
export const JWT_CLOCK_TOLERANCE_SECONDS = MAX_CLOCK_SKEW_SECONDS + 1;

// Claims carried by a session token. `role` is optional and is read by the
// authenticate middleware for role-guarded routes.
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
    // clients that mint refresh requests (at most MAX_CLOCK_SKEW_SECONDS; see
    // JWT_CLOCK_TOLERANCE_SECONDS for why the value passed is +1).
    clockTolerance: JWT_CLOCK_TOLERANCE_SECONDS,
  }) as SessionClaims;
}
