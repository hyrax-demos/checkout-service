import jwt from "jsonwebtoken";
import { config } from "../config";

const TOKEN_TTL_SECONDS = 60 * 60; // one-hour sessions

// Maximum clock skew (seconds) allowed past a token's `exp`. A token expired
// at most this long ago is accepted; anything older is rejected.
export const MAX_CLOCK_SKEW_SECONDS = 60;

// jsonwebtoken treats a token as expired when `now >= exp + clockTolerance`
// (integer seconds), so +1 makes exactly exp+60 accepted and exp+61 rejected.
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
    // clients that mint refresh requests.
    clockTolerance: JWT_CLOCK_TOLERANCE_SECONDS,
  }) as { sub: string };
}
