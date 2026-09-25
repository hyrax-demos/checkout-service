import jwt from "jsonwebtoken";
import { randomBytes, scryptSync, timingSafeEqual } from "crypto";
import { config } from "./config";

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

// Hash a password for storage using scrypt with a per-user random salt.
// Returns a `salt:hash` string suitable for the users table.
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, 32);
  return `${salt.toString("hex")}:${derived.toString("hex")}`;
}

// Constant-time comparison of a candidate password against a stored hash.
export function verifyPassword(password: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) {
    return false;
  }
  const salt = Buffer.from(saltHex, "hex");
  const expected = Buffer.from(hashHex, "hex");
  const derived = scryptSync(password, salt, expected.length);
  return timingSafeEqual(derived, expected);
}
