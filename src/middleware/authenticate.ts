import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { config } from "../config";
import { CLOCK_SKEW_TOLERANCE_SECONDS } from "../auth";

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
    const payload = jwt.verify(bearer(req), config.jwtSecret, {
      algorithms: ["HS256"],
      // Expiry is checked explicitly below (jsonwebtoken's clockTolerance
      // would reject exp == now - 60).
      ignoreExpiration: true,
    }) as SessionClaims & { exp?: unknown };
    if (payload.exp !== undefined) {
      const nowSeconds = Math.floor(Date.now() / 1000);
      if (
        typeof payload.exp !== "number" ||
        nowSeconds - payload.exp > CLOCK_SKEW_TOLERANCE_SECONDS
      ) {
        throw new Error("jwt expired");
      }
    }
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
