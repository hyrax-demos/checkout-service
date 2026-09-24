// Signs a session token the same way the real service would, for tests that
// need an authenticated request. Deliberately independent of `src/auth.ts`
// so it keeps working across an M4-style refactor of where signing lives.
import jwt from "jsonwebtoken";

export function testToken(userId: string, role?: string): string {
  return jwt.sign(
    { sub: userId, ...(role ? { role } : {}) },
    process.env.JWT_SECRET as string,
    { algorithm: "HS256", expiresIn: 3600 }
  );
}
