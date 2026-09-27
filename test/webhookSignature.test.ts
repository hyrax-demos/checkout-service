import { describe, it, expect } from "vitest";
import { createHmac, randomBytes } from "crypto";
import {
  computeSignature,
  verifySignature,
  checkTimestamp,
} from "../src/utils/webhookSignature";

// Secrets are generated per run so no credential-like literal lives in source.
const SECRET = randomBytes(32).toString("hex");
const OTHER_SECRET = randomBytes(32).toString("hex");
const BODY = JSON.stringify({
  id: "evt_1",
  type: "charge.succeeded",
  data: { orderId: "o1" },
});

describe("computeSignature", () => {
  it("returns the lowercase hex HMAC-SHA256 of the body", () => {
    const expected = createHmac("sha256", SECRET).update(BODY).digest("hex");
    expect(computeSignature(BODY, SECRET)).toBe(expected);
    expect(computeSignature(Buffer.from(BODY), SECRET)).toBe(expected);
    expect(expected).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("verifySignature", () => {
  const good = computeSignature(BODY, SECRET);

  it("accepts a correct signature", () => {
    expect(verifySignature(BODY, good, SECRET)).toBe(true);
    expect(verifySignature(Buffer.from(BODY), good, SECRET)).toBe(true);
  });

  it("rejects a tampered body", () => {
    expect(verifySignature(BODY.replace("o1", "o2"), good, SECRET)).toBe(false);
  });

  it("rejects a signature made with the wrong secret", () => {
    const wrong = computeSignature(BODY, OTHER_SECRET);
    expect(verifySignature(BODY, wrong, SECRET)).toBe(false);
  });

  it("rejects a missing or empty header", () => {
    expect(verifySignature(BODY, undefined, SECRET)).toBe(false);
    expect(verifySignature(BODY, "", SECRET)).toBe(false);
    expect(verifySignature(BODY, "sha256=", SECRET)).toBe(false);
  });

  it("rejects a different-length signature without throwing", () => {
    expect(() => verifySignature(BODY, good.slice(0, 32), SECRET)).not.toThrow();
    expect(verifySignature(BODY, good.slice(0, 32), SECRET)).toBe(false);
    expect(verifySignature(BODY, good + "00", SECRET)).toBe(false);
  });

  it("rejects malformed hex without throwing", () => {
    const bad = "zz" + good.slice(2);
    expect(() => verifySignature(BODY, bad, SECRET)).not.toThrow();
    expect(verifySignature(BODY, bad, SECRET)).toBe(false);
    expect(verifySignature(BODY, good.slice(1), SECRET)).toBe(false);
  });

  it("accepts a sha256= prefix", () => {
    expect(verifySignature(BODY, `sha256=${good}`, SECRET)).toBe(true);
  });
});

describe("checkTimestamp", () => {
  const nowMs = 1_700_000_000_000;
  const nowSec = nowMs / 1000;

  it("accepts a timestamp within the window", () => {
    expect(checkTimestamp(String(nowSec), nowMs)).toBe("ok");
    expect(checkTimestamp(String(nowSec - 300), nowMs)).toBe("ok");
    expect(checkTimestamp(String(nowSec + 300), nowMs)).toBe("ok");
  });

  it("rejects a timestamp 301s old as stale", () => {
    expect(checkTimestamp(String(nowSec - 301), nowMs)).toBe("stale");
  });

  it("rejects a timestamp more than the tolerance in the future", () => {
    expect(checkTimestamp(String(nowSec + 301), nowMs)).toBe("stale");
  });

  it("honours a custom tolerance", () => {
    expect(checkTimestamp(String(nowSec - 61), nowMs, 60)).toBe("stale");
  });

  it("rejects a non-numeric timestamp as invalid", () => {
    expect(checkTimestamp("abc", nowMs)).toBe("invalid");
    expect(checkTimestamp("1700000000.5", nowMs)).toBe("invalid");
    expect(checkTimestamp("-5", nowMs)).toBe("invalid");
  });

  it("rejects a missing timestamp as invalid", () => {
    expect(checkTimestamp(undefined, nowMs)).toBe("invalid");
    expect(checkTimestamp("", nowMs)).toBe("invalid");
  });
});
