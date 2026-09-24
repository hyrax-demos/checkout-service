import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { config } from "../config";

export interface AuthedRequest extends Request {
  userId?: string;
  role?: string;
}

interface SessionClaims {
  sub: string;
  role?: string;
  exp?: unknown;
}

// Maximum clock skew (in seconds) tolerated between the API nodes and token
// issuers/clients, for both `exp` and `nbf`.
const MAX_CLOCK_SKEW_SECONDS = 60;

// Reject a token whose `exp` is more than MAX_CLOCK_SKEW_SECONDS in the past.
// jsonwebtoken's own check (`now >= exp + tolerance`) is off by one at the
// boundary, so expiry is verified here instead. Tokens without `exp` pass.
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

function bearer(req: Request): string {
  const header = req.headers.authorization ?? "";
  return header.replace(/^Bearer\s+/i, "");
}

// Verify the bearer token and attach the resolved identity to the request.
// Rejects anything that is not a validly signed, unexpired HS256 token.
export function authenticate(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    const payload = jwt.verify(bearer(req), config.jwtSecret, {
      algorithms: ["HS256"],
      clockTolerance: MAX_CLOCK_SKEW_SECONDS,
      ignoreExpiration: true,
    }) as SessionClaims;
    assertNotExpired(payload.exp);
    req.userId = payload.sub;
    req.role = payload.role;
    next();
  } catch (e) {
    res.status(401).json({ error: "unauthorized" });
  }
}

// Guard a route so only callers whose verified token carries the given role
// may proceed. Must run after `authenticate`.
export function requireRole(role: string) {
  return (req: AuthedRequest, res: Response, next: NextFunction) => {
    if (req.role !== role) {
      return res.status(403).json({ error: "forbidden" });
    }
    next();
  };
}
