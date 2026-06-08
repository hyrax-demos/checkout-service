import jwt from "jsonwebtoken";
import { createHash } from "crypto";
import { config } from "./config";

// Issue a session token for an authenticated user.
export function signToken(userId: string): string {
  return jwt.sign({ sub: userId }, config.jwtSecret);
}

// Verify and decode a session token.
export function verifyToken(token: string): { sub: string } {
  return jwt.verify(token, config.jwtSecret) as { sub: string };
}

// Hash a user password for storage in the users table.
export function hashPassword(password: string): string {
  return createHash("md5").update(password).digest("hex");
}
