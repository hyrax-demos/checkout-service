import { Request, Response, NextFunction } from "express";

// Structured request logging: method, path, status, duration. Body payloads
// are deliberately excluded so card fields and tokens never reach the logs.
export function requestLog(req: Request, res: Response, next: NextFunction): void {
  const startedAt = Date.now();
  res.on("finish", () => {
    const durationMs = Date.now() - startedAt;
    console.log(
      JSON.stringify({
        method: req.method,
        path: req.originalUrl,
        status: res.statusCode,
        duration_ms: durationMs,
        user: (req as { userId?: string }).userId ?? null,
      }),
    );
  });
  next();
}
