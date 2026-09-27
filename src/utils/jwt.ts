import jwt from "jsonwebtoken";
import { config } from "../config";

// Single home of session-token signing and verification.

const TOKEN_TTL_SECONDS = 60 * 60; // one-hour sessions

// Maximum clock skew allowed when checking a session token's expiry: a token
// whose `exp` is at most this many seconds in the past is still accepted, and
// one whose `exp` is further in the past is rejected.
export const MAX_CLOCK_SKEW_SECONDS = 60;

// jsonwebtoken rejects when `now >= exp + clockTolerance`, i.e. the tolerance
// edge is exclusive. `exp` and `now` are whole seconds, so passing one extra
// second makes a token that expired exactly MAX_CLOCK_SKEW_SECONDS ago still
// valid while one that expired MAX_CLOCK_SKEW_SECONDS + 1 ago is rejected.
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
//
// Callers that read extra claims (e.g. `role` in the authenticate middleware)
// may narrow the returned claims type; the verification itself is identical.
export function verifyToken<T extends { sub: string } = { sub: string }>(
  token: string
): T {
  return jwt.verify(token, config.jwtSecret, {
    algorithms: ["HS256"],
    // Allow a little slack for clock drift between the API nodes and the
    // clients that mint refresh requests (see JWT_CLOCK_TOLERANCE_SECONDS for
    // why this is MAX_CLOCK_SKEW_SECONDS + 1).
    clockTolerance: JWT_CLOCK_TOLERANCE_SECONDS,
  }) as T;
}
