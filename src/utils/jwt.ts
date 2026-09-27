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
  const payload = jwt.verify(token, config.jwtSecret, {
    algorithms: ["HS256"],
    // Allow a little slack for clock drift between the API nodes and the
    // clients that mint refresh requests.
    clockTolerance: CLOCK_TOLERANCE_SECONDS,
    // jsonwebtoken rejects when `now >= exp + clockTolerance`, i.e. a token
    // that expired exactly CLOCK_TOLERANCE_SECONDS ago is already refused.
    // The expiry check is done below instead so that a token is accepted
    // while `now - exp <= CLOCK_TOLERANCE_SECONDS` and rejected beyond that.
    ignoreExpiration: true,
  }) as jwt.JwtPayload;

  if (payload.exp !== undefined) {
    if (typeof payload.exp !== "number") {
      throw new jwt.JsonWebTokenError("invalid exp value");
    }
    const now = Math.floor(Date.now() / 1000);
    if (now - payload.exp > CLOCK_TOLERANCE_SECONDS) {
      throw new jwt.TokenExpiredError("jwt expired", new Date(payload.exp * 1000));
    }
  }

  return payload as { sub: string };
}
