import jwt from "jsonwebtoken";
import { config } from "../config";

const TOKEN_TTL_SECONDS = 60 * 60; // one-hour sessions

// Maximum allowed clock skew, in seconds, when checking a session token's
// expiry. A token whose `exp` is more than this many seconds in the past is
// rejected; a token whose `exp` is at most this many seconds in the past is
// still accepted.
export const MAX_CLOCK_SKEW_SECONDS = 60;

// jsonwebtoken@8.5.1 rejects when `nowSeconds >= exp + clockTolerance`, so a
// plain `clockTolerance: MAX_CLOCK_SKEW_SECONDS` would reject a token whose
// `exp` is exactly MAX_CLOCK_SKEW_SECONDS in the past. The "+1" corrects that
// off-by-one so exp = now-60 is accepted and exp = now-61 is rejected.
const CLOCK_TOLERANCE_SECONDS = MAX_CLOCK_SKEW_SECONDS + 1;

// Shared options for verifying a session token, kept in one place so every
// caller enforces the same algorithm, secret and clock-skew tolerance.
const VERIFY_OPTIONS = {
  algorithms: ["HS256"] as jwt.Algorithm[],
  // Allow a little slack for clock drift between the API nodes and the
  // clients that mint refresh requests.
  clockTolerance: CLOCK_TOLERANCE_SECONDS,
};

export interface SessionTokenPayload {
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
export function verifyToken(token: string): { sub: string } {
  return jwt.verify(token, config.jwtSecret, VERIFY_OPTIONS) as { sub: string };
}
