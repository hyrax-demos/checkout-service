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
    // `verifyToken`'s declared return type only names `sub`, but at runtime
    // it returns the full decoded payload (as the inline `jwt.verify` call
    // it replaces did), so `role` is still present on tokens that carry it.
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
