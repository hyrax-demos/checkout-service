import jwt from "jsonwebtoken";
import { randomBytes, scryptSync, timingSafeEqual } from "crypto";
import { config } from "./config";

const TOKEN_TTL_SECONDS = 60 * 60; // one-hour sessions

// Maximum allowed clock skew, in seconds, when checking a session token's
// expiry. A token whose `exp` is more than this many seconds in the past is
// rejected; a token whose `exp` is at most this many seconds in the past is
// still accepted.
export const MAX_CLOCK_SKEW_SECONDS = 60;

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
    //
    // jsonwebtoken@8.5.1 rejects when `nowSeconds >= exp + clockTolerance`,
    // so a plain `clockTolerance: MAX_CLOCK_SKEW_SECONDS` would reject a
    // token whose `exp` is exactly MAX_CLOCK_SKEW_SECONDS in the past. The
    // "+1" corrects that off-by-one so exp = now-60 is accepted and
    // exp = now-61 is rejected.
    clockTolerance: MAX_CLOCK_SKEW_SECONDS + 1,
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
