import { randomBytes, scryptSync, timingSafeEqual } from "crypto";

// Session-token signing/verification lives in ./utils/jwt; re-exported here so
// existing `import { signToken, verifyToken } from "./auth"` sites keep working.
export {
  signToken,
  verifyToken,
  MAX_CLOCK_SKEW_SECONDS,
  JWT_CLOCK_TOLERANCE_SECONDS,
} from "./utils/jwt";

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
