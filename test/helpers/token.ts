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

export interface ExpiredTokenOptions {
  sub?: string;
  role?: string;
  // Reference "now" in epoch seconds; defaults to the current (possibly
  // faked) clock.
  now?: number;
}

// Signs an otherwise-valid session token whose `exp` is `secondsAgo` seconds
// before `now`. A negative value yields a token that has not yet expired.
export function tokenExpiredSecondsAgo(
  secondsAgo: number,
  { sub = "user-skew", role, now = Math.floor(Date.now() / 1000) }: ExpiredTokenOptions = {}
): string {
  return jwt.sign(
    {
      sub,
      ...(role ? { role } : {}),
      iat: now - 3600 - secondsAgo,
      exp: now - secondsAgo,
    },
    process.env.JWT_SECRET as string,
    { algorithm: "HS256" }
  );
}
