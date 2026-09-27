import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { testToken } from "./helpers/token";

vi.mock("../src/db", () => ({
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
    text: strings.join("?"),
    values,
  }),
  query: vi.fn(),
  withTransaction: vi.fn(),
}));

import { query } from "../src/db";
import { buildApp } from "./helpers/app";
import { config } from "../src/config";
import { rateLimit } from "../src/middleware/rateLimit";

const mockedQuery = query as unknown as ReturnType<typeof vi.fn>;

function fakeRes() {
  const res: any = {
    headers: {} as Record<string, string>,
    statusCode: 200,
    body: undefined as unknown,
  };
  res.set = vi.fn((name: string, value: string) => {
    res.headers[name] = value;
    return res;
  });
  res.status = vi.fn((code: number) => {
    res.statusCode = code;
    return res;
  });
  res.json = vi.fn((body: unknown) => {
    res.body = body;
    return res;
  });
  return res;
}

function hit(limiter: ReturnType<typeof rateLimit>, userId?: string) {
  const res = fakeRes();
  const next = vi.fn();
  limiter({ userId } as any, res, next);
  return { res, next };
}

describe("rateLimit middleware", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows requests under the limit", () => {
    const limiter = rateLimit({ maxRequests: 10, windowMs: 60_000 });
    for (let i = 0; i < 10; i++) {
      const { res, next } = hit(limiter, "cust-1");
      expect(next).toHaveBeenCalledTimes(1);
      expect(res.status).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1_000);
    }
  });

  it("rejects the request over the limit with 429 and Retry-After", () => {
    const limiter = rateLimit({ maxRequests: 10, windowMs: 60_000 });
    for (let i = 0; i < 10; i++) {
      hit(limiter, "cust-1");
    }
    vi.advanceTimersByTime(15_000);

    const { res, next } = hit(limiter, "cust-1");
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(429);
    // The oldest request expires 45s from now.
    expect(res.headers["Retry-After"]).toBe("45");
  });

  it("keys the limit per customer", () => {
    const limiter = rateLimit({ maxRequests: 10, windowMs: 60_000 });
    for (let i = 0; i < 10; i++) {
      hit(limiter, "cust-1");
    }
    expect(hit(limiter, "cust-1").next).not.toHaveBeenCalled();
    expect(hit(limiter, "cust-2").next).toHaveBeenCalledTimes(1);
  });

  it("allows requests again once the window slides past them", () => {
    const limiter = rateLimit({ maxRequests: 10, windowMs: 60_000 });
    // 5 requests at t=0 and 5 at t=30s.
    for (let i = 0; i < 5; i++) hit(limiter, "cust-1");
    vi.advanceTimersByTime(30_000);
    for (let i = 0; i < 5; i++) hit(limiter, "cust-1");
    expect(hit(limiter, "cust-1").res.statusCode).toBe(429);

    // At t=60s the first five have left the window. Only five slots free up.
    vi.advanceTimersByTime(30_000);
    for (let i = 0; i < 5; i++) {
      expect(hit(limiter, "cust-1").next).toHaveBeenCalledTimes(1);
    }
    const blocked = hit(limiter, "cust-1");
    expect(blocked.res.statusCode).toBe(429);
    expect(blocked.res.headers["Retry-After"]).toBe("30");

    // After a full idle window everything is free again.
    vi.advanceTimersByTime(60_000);
    for (let i = 0; i < 10; i++) {
      expect(hit(limiter, "cust-1").next).toHaveBeenCalledTimes(1);
    }
  });

  it("does not count rejected requests against the window", () => {
    const limiter = rateLimit({ maxRequests: 10, windowMs: 60_000 });
    for (let i = 0; i < 10; i++) hit(limiter, "cust-1");
    vi.advanceTimersByTime(59_000);
    for (let i = 0; i < 5; i++) {
      expect(hit(limiter, "cust-1").res.statusCode).toBe(429);
    }
    vi.advanceTimersByTime(1_000);
    expect(hit(limiter, "cust-1").next).toHaveBeenCalledTimes(1);
  });

  it("rejects a request with no authenticated customer", () => {
    const limiter = rateLimit({ maxRequests: 10, windowMs: 60_000 });
    const { res, next } = hit(limiter, undefined);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });
});

describe("rate limiting on payment routes", () => {
  const app = buildApp();
  let customer = 0;

  beforeEach(() => {
    // Only fake Date so supertest's real sockets and timers still work.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    mockedQuery.mockReset();
    mockedQuery.mockResolvedValue([]);
    customer += 1;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses a default of 10 requests per minute", () => {
    expect(config.rateLimit).toEqual({ maxRequests: 10, windowMs: 60_000 });
  });

  for (const [path, body] of [
    ["/payments/charge", { orderId: "order-1" }],
    ["/refunds", { reference: "ord_abc", amountDollars: 5 }],
  ] as const) {
    it(`limits POST ${path} per customer and resets after the window`, async () => {
      const token = testToken(`rl-user-${customer}`);
      const other = testToken(`rl-other-${customer}`);
      const send = (t: string) =>
        request(app).post(path).set("Authorization", `Bearer ${t}`).send(body);

      for (let i = 0; i < config.rateLimit.maxRequests; i++) {
        expect((await send(token)).status).toBe(404);
      }

      const limited = await send(token);
      expect(limited.status).toBe(429);
      expect(limited.headers["retry-after"]).toBe("60");
      expect((await send(other)).status).toBe(404);

      vi.advanceTimersByTime(config.rateLimit.windowMs);
      expect((await send(token)).status).toBe(404);
    });
  }
});
