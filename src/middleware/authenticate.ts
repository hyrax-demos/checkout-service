import { Request, Response, NextFunction } from "express";
import { verifyToken } from "../utils/jwt";

export interface AuthedRequest extends Request {
  userId?: string;
  role?: string;
}

interface SessionClaims {
  sub: string;
  role?: string;
}

function bearer(req: Request): string {
  const header = req.headers.authorization ?? "";
  return header.replace(/^Bearer\s+/i, "");
}

// Verify the bearer token and attach the resolved identity to the request.
// Rejects anything that is not a validly signed, unexpired HS256 token.
export function authenticate(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    // The shared verifier returns the full decoded payload; `role` is an
    // optional claim carried alongside `sub`.
    const payload = verifyToken(bearer(req)) as SessionClaims;
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
