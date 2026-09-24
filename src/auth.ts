import jwt from "jsonwebtoken";
import { randomBytes, scryptSync, timingSafeEqual } from "crypto";
import { config } from "./config";

const TOKEN_TTL_SECONDS = 60 * 60; // one-hour sessions

// Maximum clock skew (in seconds) tolerated between the API nodes and token
// issuers/clients, for both `exp` and `nbf`.
const MAX_CLOCK_SKEW_SECONDS = 60;

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
  const payload = jwt.verify(token, config.jwtSecret, {
    algorithms: ["HS256"],
    // Allow a little slack for clock drift between the API nodes and the
    // clients that mint refresh requests. `nbf` gets this tolerance from the
    // library; `exp` is checked below because jsonwebtoken's own comparison
    // (`now >= exp + tolerance`) would reject a token that expired exactly
    // MAX_CLOCK_SKEW_SECONDS ago.
    clockTolerance: MAX_CLOCK_SKEW_SECONDS,
    ignoreExpiration: true,
  }) as { sub: string; exp?: unknown };
  assertNotExpired(payload.exp);
  return payload as { sub: string };
}

// Reject a token whose `exp` is more than MAX_CLOCK_SKEW_SECONDS in the past.
// Tokens without an `exp` claim are left alone, as before.
function assertNotExpired(exp: unknown): void {
  if (typeof exp === "undefined") {
    return;
  }
  if (typeof exp !== "number") {
    throw new jwt.JsonWebTokenError("invalid exp value");
  }
  if (Math.floor(Date.now() / 1000) - exp > MAX_CLOCK_SKEW_SECONDS) {
    throw new jwt.TokenExpiredError("jwt expired", new Date(exp * 1000));
  }
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
