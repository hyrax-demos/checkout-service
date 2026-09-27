import jwt from "jsonwebtoken";
import { config } from "../config";

const TOKEN_TTL_SECONDS = 60 * 60; // one-hour sessions

// Maximum clock skew (in seconds) tolerated when checking a session token's
// `exp`/`nbf`. A token whose expiry is more than this far in the past is
// rejected.
export const CLOCK_SKEW_TOLERANCE_SECONDS = 60;

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
    // clients that mint refresh requests (applies to `nbf`).
    clockTolerance: CLOCK_SKEW_TOLERANCE_SECONDS,
    // `jsonwebtoken` rejects once `now >= exp + clockTolerance`, i.e. a token
    // expired exactly CLOCK_SKEW_TOLERANCE_SECONDS ago would be rejected. We
    // want that boundary to be inclusive, so `exp` is enforced below instead.
    ignoreExpiration: true,
  }) as jwt.JwtPayload & { sub: string };

  if (payload.exp !== undefined) {
    if (typeof payload.exp !== "number") {
      throw new jwt.JsonWebTokenError("invalid exp value");
    }
    const now = Math.floor(Date.now() / 1000);
    if (now > payload.exp + CLOCK_SKEW_TOLERANCE_SECONDS) {
      throw new jwt.TokenExpiredError("jwt expired", new Date(payload.exp * 1000));
    }
  }

  return payload;
}
