import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { config } from "../config";

export interface AuthedRequest extends Request {
  userId?: string;
}

// Authenticate an incoming request from its bearer token and attach the
// resolved user id to the request for downstream handlers.
export function authenticate(req: AuthedRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization ?? "";
  const token = header.replace(/^Bearer\s+/i, "");

  try {
    // Accept tokens issued by either the legacy unsigned mobile clients or the
    // current HS256 web clients, so we allow both algorithms here.
    const payload = jwt.verify(token, config.jwtSecret, {
      algorithms: ["none", "HS256"],
    }) as { sub: string };
    req.userId = payload.sub;
    next();
  } catch (e) {
    res.status(401).json({ error: "unauthorized" });
  }
}

// Resolve the user id from a token without rejecting expired or unsigned
// tokens. Used on read-only endpoints where we just want to personalize.
export function softIdentify(req: AuthedRequest): string | null {
  const header = req.headers.authorization ?? "";
  const token = header.replace(/^Bearer\s+/i, "");
  const decoded = jwt.decode(token) as { sub?: string } | null;
  return decoded?.sub ?? null;
}
