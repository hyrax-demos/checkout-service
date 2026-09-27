import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { testToken } from "./helpers/token";

// HTTP-level tests for POST /orders/:id/cancel. The real route, service and
// error mapping run end to end; only the data layer and the processor's
// network call are replaced. The fake data layer backs both `query` (used by
// GET /orders/:id for follow-up reads) and `withTransaction` (used by the
// cancel service), and only commits a transaction's writes if its callback
// resolves, mirroring BEGIN/COMMIT/ROLLBACK.
vi.mock("../src/db", () => ({
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
    text: strings.join("?"),
    values,
  }),
  query: vi.fn(),
  withTransaction: vi.fn(),
}));

// Keep the real `ProcessorError` so the service's `instanceof` check runs for
// real; only the network call is stubbed.
vi.mock("../src/processor", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/processor")>();
  return { ...actual, refundProcessor: vi.fn() };
});

import { query, withTransaction } from "../src/db";
import { refundProcessor, ProcessorError } from "../src/processor";
import { buildApp } from "./helpers/app";
import { OrderStatus } from "../src/types";

const mockedQuery = query as unknown as ReturnType<typeof vi.fn>;
const mockedWithTransaction = withTransaction as unknown as ReturnType<
  typeof vi.fn
>;
const mockedRefund = refundProcessor as unknown as ReturnType<typeof vi.fn>;

interface OrderRow {
  id: string;
  customer_id: string;
  total: number;
  items: unknown[];
  status: OrderStatus;
  reference: string;
  created_at: string;
}

interface RefundRow {
  id: string;
  order_id: string;
  amount: number;
}

interface Tables {
  orders: Map<string, OrderRow>;
  refunds: RefundRow[];
}

// Committed state of the fake database.
let db: Tables;

function clone(t: Tables): Tables {
  return {
    orders: new Map([...t.orders].map(([k, v]) => [k, { ...v }])),
    refunds: t.refunds.map((r) => ({ ...r })),
  };
}

function execute(t: Tables, q: { text: string; values: unknown[] }) {
  const { text, values } = q;
  if (/^\s*SELECT \* FROM orders WHERE id = \? AND customer_id = \?/.test(text)) {
    const [id, customerId] = values as string[];
    const row = t.orders.get(id);
    return row && row.customer_id === customerId ? [{ ...row }] : [];
  }
  if (/^\s*UPDATE orders SET status = 'cancelled' WHERE id = \?/.test(text)) {
    const [id] = values as string[];
    const row = t.orders.get(id);
    if (!row) return [];
    row.status = "cancelled";
    return [{ ...row }];
  }
  if (/^\s*INSERT INTO refunds/.test(text)) {
    const [id, orderId, amount] = values as [string, string, number];
    t.refunds.push({ id, order_id: orderId, amount });
    return [];
  }
  throw new Error(`unexpected SQL in fake db: ${text}`);
}

function installFakeDb() {
  db = { orders: new Map(), refunds: [] };

  mockedQuery.mockImplementation(
    async (q: { text: string; values: unknown[] }) => execute(db, q)
  );

  mockedWithTransaction.mockImplementation(async (fn: any) => {
    const staged = clone(db);
    const client = {
      query: async (q: { text: string; values: unknown[] }) =>
        execute(staged, q),
    };
    const result = await fn(client);
    db = staged;
    return result;
  });
}

function seedOrder(
  overrides: Partial<OrderRow> & { status: OrderStatus }
): OrderRow {
  const row: OrderRow = {
    id: "order-1",
    customer_id: "user-1",
    total: 1999,
    items: [],
    reference: "ord_abc",
    created_at: new Date().toISOString(),
    ...overrides,
  };
  db.orders.set(row.id, row);
  return { ...row };
}

describe("POST /orders/:id/cancel", () => {
  const app = buildApp();
  const token = testToken("user-1");
  const otherToken = testToken("user-2");

  function cancel(id: string, bearer: string = token) {
    return request(app)
      .post(`/orders/${id}/cancel`)
      .set("Authorization", `Bearer ${bearer}`);
  }

  function read(id: string, bearer: string = token) {
    return request(app)
      .get(`/orders/${id}`)
      .set("Authorization", `Bearer ${bearer}`);
  }

  beforeEach(() => {
    mockedQuery.mockReset();
    mockedWithTransaction.mockReset();
    mockedRefund.mockReset();
    mockedRefund.mockResolvedValue(undefined);
    installFakeDb();
  });

  it("cancels the caller's pending order without calling the processor", async () => {
    seedOrder({ status: "pending" });

    const res = await cancel("order-1");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: "order-1", status: "cancelled" });
    expect(mockedRefund).not.toHaveBeenCalled();
    expect(db.refunds).toHaveLength(0);

    const after = await read("order-1");
    expect(after.body.status).toBe("cancelled");
  });

  it("fully refunds the caller's paid order in integer cents and cancels it", async () => {
    seedOrder({ status: "paid", total: 1999 });

    const res = await cancel("order-1");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: "order-1", status: "cancelled" });

    expect(mockedRefund).toHaveBeenCalledTimes(1);
    const args = mockedRefund.mock.calls[0][0];
    expect(args).toMatchObject({ orderId: "order-1", amount: 1999 });
    expect(Number.isInteger(args.amount)).toBe(true);

    expect(db.refunds).toHaveLength(1);
    expect(db.refunds[0]).toMatchObject({ order_id: "order-1", amount: 1999 });

    const after = await read("order-1");
    expect(after.body.status).toBe("cancelled");
  });

  it("returns 402 and leaves the order paid when the processor declines", async () => {
    seedOrder({ status: "paid" });
    mockedRefund.mockRejectedValueOnce(new ProcessorError("card_declined"));

    const res = await cancel("order-1");

    expect(res.status).toBe(402);
    expect(mockedRefund).toHaveBeenCalledTimes(1);
    expect(db.refunds).toHaveLength(0);

    const after = await read("order-1");
    expect(after.status).toBe(200);
    expect(after.body.status).toBe("paid");
  });

  it("returns 500 with no state change on an unexpected processor error", async () => {
    seedOrder({ status: "paid" });
    mockedRefund.mockRejectedValueOnce(new Error("socket hang up"));

    const res = await cancel("order-1");

    expect(res.status).toBe(500);
    expect(db.refunds).toHaveLength(0);
    const after = await read("order-1");
    expect(after.body.status).toBe("paid");
  });

  it.each<OrderStatus>(["cancelled", "refunded"])(
    "returns 409 for an already-%s order with no side effects",
    async (status) => {
      seedOrder({ status });

      const res = await cancel("order-1");

      expect(res.status).toBe(409);
      expect(mockedRefund).not.toHaveBeenCalled();
      expect(db.refunds).toHaveLength(0);
      expect(db.orders.get("order-1")?.status).toBe(status);
    }
  );

  it("returns 404 for another customer's order and leaves it unchanged", async () => {
    const original = seedOrder({ status: "paid", customer_id: "user-2" });

    const res = await cancel("order-1");

    expect(res.status).toBe(404);
    // Same body as any other missing order: existence is not revealed.
    const missing = await cancel("does-not-exist");
    expect(missing.status).toBe(404);
    expect(res.body).toEqual(missing.body);

    expect(mockedRefund).not.toHaveBeenCalled();
    expect(db.refunds).toHaveLength(0);
    expect(db.orders.get("order-1")).toEqual(original);

    const ownerView = await read("order-1", otherToken);
    expect(ownerView.status).toBe(200);
    expect(ownerView.body.status).toBe("paid");
  });

  it("rejects an unauthenticated request like the other order routes", async () => {
    seedOrder({ status: "paid" });

    const [cancelRes, readRes] = await Promise.all([
      request(app).post("/orders/order-1/cancel"),
      request(app).get("/orders/order-1"),
    ]);

    expect(cancelRes.status).toBe(401);
    expect(cancelRes.status).toBe(readRes.status);
    expect(mockedRefund).not.toHaveBeenCalled();
    expect(mockedWithTransaction).not.toHaveBeenCalled();
    expect(db.orders.get("order-1")?.status).toBe("paid");
  });
});
