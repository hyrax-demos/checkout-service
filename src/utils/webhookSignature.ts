import { createHmac, timingSafeEqual } from "crypto";

// Pure helpers for verifying payment-processor webhooks. They take the secret
// and the current time as arguments so they carry no config or clock
// dependency and can be unit-tested directly.

const SIGNATURE_PREFIX = "sha256=";
const HEX_PATTERN = /^[0-9a-fA-F]+$/;
const UNIX_SECONDS_PATTERN = /^\d+$/;

export const DEFAULT_TIMESTAMP_TOLERANCE_SEC = 300;

// Lowercase hex HMAC-SHA256 of the exact raw body bytes, keyed with `secret`.
export function computeSignature(
  rawBody: Buffer | string,
  secret: string
): string {
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}

// Check a signature header against the raw body. Returns false (never throws)
// for a missing/empty header, malformed hex, or a length mismatch; otherwise
// compares the decoded bytes in constant time.
export function verifySignature(
  rawBody: Buffer | string,
  header: string | undefined,
  secret: string
): boolean {
  if (!header) return false;

  let provided = header.trim();
  if (provided.toLowerCase().startsWith(SIGNATURE_PREFIX)) {
    provided = provided.slice(SIGNATURE_PREFIX.length);
  }
  if (provided.length === 0 || provided.length % 2 !== 0) return false;
  if (!HEX_PATTERN.test(provided)) return false;

  const a = Buffer.from(provided, "hex");
  const b = Buffer.from(computeSignature(rawBody, secret), "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// "invalid" covers a missing, empty or non-numeric header; "stale" covers a
// timestamp outside the tolerance window in either direction.
export type TimestampCheck = "ok" | "invalid" | "stale";

// Validate a unix-seconds timestamp header against `nowMs`. Values older than
// `toleranceSec`, or more than `toleranceSec` in the future, are stale.
export function checkTimestamp(
  header: string | undefined,
  nowMs: number = Date.now(),
  toleranceSec: number = DEFAULT_TIMESTAMP_TOLERANCE_SEC
): TimestampCheck {
  if (header === undefined) return "invalid";
  const value = header.trim();
  if (!UNIX_SECONDS_PATTERN.test(value)) return "invalid";

  const timestampSec = Number(value);
  if (!Number.isSafeInteger(timestampSec)) return "invalid";

  const skewMs = Math.abs(nowMs - timestampSec * 1000);
  return skewMs > toleranceSec * 1000 ? "stale" : "ok";
}
