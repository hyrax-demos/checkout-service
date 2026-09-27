import jwt from "jsonwebtoken";
import { config } from "../config";

const TOKEN_TTL_SECONDS = 60 * 60; // one-hour sessions

// Maximum clock skew (in seconds) accepted past a token's `exp`.
const CLOCK_TOLERANCE_SECONDS = 60;

// Issue a signed session token for an authenticated user.
export function signToken(userId: string): string {
  return jwt.sign({ sub: userId }, config.jwtSecret, {
    algorithm: "HS256",
    expiresIn: TOKEN_TTL_SECONDS,
  });
}

// Verify a session token and return its claims. Throws if the signature is
// invalid, the algorithm is unexpected, or the token has expired (beyond the
// allowed clock-skew tolerance).
export function verifyToken(token: string): { sub: string } {
  return jwt.verify(token, config.jwtSecret, {
    algorithms: ["HS256"],
    // Allow a little slack for clock drift between the API nodes and the
    // clients that mint refresh requests.
    clockTolerance: CLOCK_TOLERANCE_SECONDS,
  }) as { sub: string };
}
