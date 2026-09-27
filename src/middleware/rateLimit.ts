import { Response, NextFunction } from "express";
import { AuthedRequest } from "./authenticate";

export interface RateLimitOptions {
  maxRequests: number;
  windowMs: number;
}

// Per-customer sliding-window rate limiter, keyed on the authenticated
// `req.userId`. Must run after `authenticate`.
//
// Each limiter keeps a log of accepted request timestamps per customer in
// memory. A request is allowed if fewer than `maxRequests` were accepted in
// the last `windowMs` ms. Otherwise it gets a 429 with a `Retry-After` header
// (whole seconds) telling the client when the oldest request in the window
// expires. Rejected requests are not recorded, so a client that keeps retrying
// does not push its own window forward.
//
// State lives in this process only. Each replica enforces its own limit.
export function rateLimit({ maxRequests, windowMs }: RateLimitOptions) {
  const hits = new Map<string, number[]>();

  return (req: AuthedRequest, res: Response, next: NextFunction) => {
    const key = req.userId;
    if (!key) {
      // Should not happen once `authenticate` has run. Fail closed.
      return res.status(401).json({ error: "unauthorized" });
    }

    const now = Date.now();
    const windowStart = now - windowMs;
    const recent = (hits.get(key) ?? []).filter((t) => t > windowStart);

    if (recent.length >= maxRequests) {
      hits.set(key, recent);
      const retryAfterMs = recent[0] + windowMs - now;
      res.set("Retry-After", String(Math.max(1, Math.ceil(retryAfterMs / 1000))));
      return res.status(429).json({ error: "too many requests" });
    }

    recent.push(now);
    hits.set(key, recent);

    // Drop customers whose windows have fully expired so the map does not
    // grow without bound.
    if (hits.size > 10_000) {
      for (const [k, times] of hits) {
        if (times[times.length - 1] <= windowStart) {
          hits.delete(k);
        }
      }
    }

    next();
  };
}
