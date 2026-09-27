import { describe, it, expect, vi, beforeEach } from "vitest";

// Service-level tests for `cancelOrder`. The data layer is replaced by an
// in-memory fake: `withTransaction` hands the callback a client whose
// `query` is routed by SQL text, stages writes, and only commits them to the
// "tables" below if the callback resolves (mirroring BEGIN/COMMIT/ROLLBACK).
vi.mock("../src/db", () => ({
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
    text: strings.join("?"),
    values,
  }),
  query: vi.fn(),
  withTransaction: vi.fn(),
}));

// Keep the real `ProcessorError` class so the service's `instanceof` check is
// exercised for real; only the network call is stubbed.
vi.mock("../src/processor", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/processor")>();
  return { ...actual, refundProcessor: vi.fn() };
});

import { query, withTransaction } from "../src/db";
import { refundProcessor, ProcessorError } from "../src/processor";
import { cancelOrder } from "../src/services/orders";
import {
  NotFoundError,
  OrderNotCancellableError,
  PaymentFailedError,
} from "../src/errors";
import { Order, OrderStatus } from "../src/types";

const mockedQuery = query as unknown as ReturnType<typeof vi.fn>;
const mockedWithTransaction = withTransaction as unknown as ReturnType<
  typeof vi.fn
>;
const mockedRefund = refundProcessor as unknown as ReturnType<typeof vi.fn>;

interface OrderRow extends Omit<Order, "total"> {
  customer_id: string;
  total: number | string;
}

interface RefundRow {
  id: string;
  order_id: string;
  amount: number;
}

// Committed state of the fake database.
let orders: Map<string, OrderRow>;
let refunds: RefundRow[];
// Every statement issued inside a transaction, in order.
let txQuery: ReturnType<typeof vi.fn>;

function isWrite(text: string): boolean {
  return /^\s*(INSERT|UPDATE|DELETE)\b/i.test(text);
}

function writeCalls(): string[] {
  return txQuery.mock.calls
    .map(([q]) => (q as { text: string }).text)
    .filter(isWrite);
}

function installFakeDb() {
  orders = new Map();
  refunds = [];
  txQuery = vi.fn();

  mockedWithTransaction.mockImplementation(async (fn: any) => {
    const stagedOrders = new Map<string, OrderRow>(
      [...orders].map(([k, v]) => [k, { ...v }])
    );
    const stagedRefunds = refunds.map((r) => ({ ...r }));

    txQuery.mockImplementation(
      async (q: { text: string; values: unknown[] }) => {
        const { text, values } = q;
        if (/^\s*SELECT \* FROM orders/.test(text)) {
          const [id, customerId] = values as string[];
          const row = stagedOrders.get(id);
          return row && row.customer_id === customerId ? [{ ...row }] : [];
        }
        if (/^\s*UPDATE orders SET status = 'cancelled'/.test(text)) {
          const [id] = values as string[];
          const row = stagedOrders.get(id);
          if (!row) return [];
          row.status = "cancelled";
          return [{ ...row }];
        }
        if (/^\s*INSERT INTO refunds/.test(text)) {
          const [id, orderId, amount] = values as [string, string, number];
          stagedRefunds.push({ id, order_id: orderId, amount });
          return [];
        }
        throw new Error(`unexpected SQL in fake db: ${text}`);
      }
    );

    // Commit only if the unit of work resolves; a throw discards the stage.
    const result = await fn({ query: txQuery });
    orders = stagedOrders;
    refunds = stagedRefunds;
    return result;
  });
}

function seedOrder(
  overrides: Partial<OrderRow> & { status: OrderStatus }
): OrderRow {
  const row: OrderRow = {
    id: "order-1",
    customerId: "cust-1",
    customer_id: "cust-1",
    total: 1999,
    items: [],
    reference: "ord_abc",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
  orders.set(row.id, row);
  return row;
}

describe("cancelOrder", () => {
  beforeEach(() => {
    mockedQuery.mockReset();
    mockedWithTransaction.mockReset();
    mockedRefund.mockReset();
    mockedRefund.mockResolvedValue(undefined);
    installFakeDb();
  });

  it("cancels a pending order without calling the processor or writing a refund", async () => {
    seedOrder({ status: "pending" });

    const result = await cancelOrder({
      orderId: "order-1",
      customerId: "cust-1",
    });

    expect(result.status).toBe("cancelled");
    expect(orders.get("order-1")?.status).toBe("cancelled");
    expect(mockedRefund).not.toHaveBeenCalled();
    expect(refunds).toHaveLength(0);
  });

  it("fully refunds a paid order in integer cents, records the refund and cancels", async () => {
    seedOrder({ status: "paid", total: 1999 });

    const result = await cancelOrder({
      orderId: "order-1",
      customerId: "cust-1",
    });

    expect(mockedRefund).toHaveBeenCalledTimes(1);
    const args = mockedRefund.mock.calls[0][0];
    expect(args).toMatchObject({ orderId: "order-1", amount: 1999 });
    expect(Number.isInteger(args.amount)).toBe(true);

    expect(refunds).toHaveLength(1);
    expect(refunds[0]).toMatchObject({ order_id: "order-1", amount: 1999 });
    expect(typeof refunds[0].id).toBe("string");

    expect(result.status).toBe("cancelled");
    expect(orders.get("order-1")?.status).toBe("cancelled");
  });

  it("normalises a string-typed cents total (as pg may return) to an integer", async () => {
    seedOrder({ status: "paid", total: "1999" });

    await cancelOrder({ orderId: "order-1", customerId: "cust-1" });

    expect(mockedRefund).toHaveBeenCalledTimes(1);
    expect(mockedRefund.mock.calls[0][0].amount).toBe(1999);
    expect(refunds[0].amount).toBe(1999);
  });

  it("raises PaymentFailedError and leaves the order paid when the processor declines", async () => {
    seedOrder({ status: "paid" });
    const declined = new ProcessorError("card_declined");
    mockedRefund.mockRejectedValueOnce(declined);

    const err = await cancelOrder({
      orderId: "order-1",
      customerId: "cust-1",
    }).catch((e) => e);

    expect(err).toBeInstanceOf(PaymentFailedError);
    expect((err as PaymentFailedError).cause).toBe(declined);
    expect(mockedRefund).toHaveBeenCalledTimes(1);
    expect(orders.get("order-1")?.status).toBe("paid");
    expect(refunds).toHaveLength(0);
  });

  it("issues no writes at all when the processor rejects", async () => {
    seedOrder({ status: "paid" });
    mockedRefund.mockRejectedValueOnce(new ProcessorError("boom"));

    await expect(
      cancelOrder({ orderId: "order-1", customerId: "cust-1" })
    ).rejects.toBeInstanceOf(PaymentFailedError);

    // Not merely rolled back: nothing was written in the first place.
    expect(writeCalls()).toEqual([]);
  });

  it("propagates unexpected processor errors unchanged with no writes", async () => {
    seedOrder({ status: "paid" });
    const unexpected = new Error("socket hang up");
    mockedRefund.mockRejectedValueOnce(unexpected);

    const err = await cancelOrder({
      orderId: "order-1",
      customerId: "cust-1",
    }).catch((e) => e);

    expect(err).toBe(unexpected);
    expect(err).not.toBeInstanceOf(PaymentFailedError);
    expect(writeCalls()).toEqual([]);
    expect(orders.get("order-1")?.status).toBe("paid");
    expect(refunds).toHaveLength(0);
  });

  it("writes the refund row and status change only after the processor resolves", async () => {
    seedOrder({ status: "paid" });

    await cancelOrder({ orderId: "order-1", customerId: "cust-1" });

    const processorAt = mockedRefund.mock.invocationCallOrder[0];
    const writeOrders = txQuery.mock.calls
      .map(([q], i) => ({
        text: (q as { text: string }).text,
        at: txQuery.mock.invocationCallOrder[i],
      }))
      .filter((c) => isWrite(c.text));

    expect(writeOrders.map((c) => c.text)).toEqual([
      expect.stringMatching(/^INSERT INTO refunds/),
      expect.stringMatching(/^UPDATE orders SET status = 'cancelled'/),
    ]);
    for (const w of writeOrders) {
      expect(w.at).toBeGreaterThan(processorAt);
    }
  });

  it.each<OrderStatus>(["cancelled", "refunded"])(
    "rejects an already-%s order as a conflict with no processor call or writes",
    async (status) => {
      seedOrder({ status });

      const err = await cancelOrder({
        orderId: "order-1",
        customerId: "cust-1",
      }).catch((e) => e);

      expect(err).toBeInstanceOf(OrderNotCancellableError);
      expect((err as OrderNotCancellableError).status).toBe(status);
      expect(mockedRefund).not.toHaveBeenCalled();
      expect(writeCalls()).toEqual([]);
      expect(orders.get("order-1")?.status).toBe(status);
      expect(refunds).toHaveLength(0);
    }
  );

  it("treats another customer's order as not found, with no processor call or writes", async () => {
    seedOrder({ status: "paid", customerId: "cust-2", customer_id: "cust-2" });

    const err = await cancelOrder({
      orderId: "order-1",
      customerId: "cust-1",
    }).catch((e) => e);

    expect(err).toBeInstanceOf(NotFoundError);
    expect(mockedRefund).not.toHaveBeenCalled();
    expect(writeCalls()).toEqual([]);
    expect(orders.get("order-1")?.status).toBe("paid");
    expect(refunds).toHaveLength(0);
  });

  it("raises NotFoundError for a non-existent order id", async () => {
    const err = await cancelOrder({
      orderId: "does-not-exist",
      customerId: "cust-1",
    }).catch((e) => e);

    expect(err).toBeInstanceOf(NotFoundError);
    expect(mockedRefund).not.toHaveBeenCalled();
    expect(writeCalls()).toEqual([]);
  });

  it("scopes the lookup to the caller and locks the row", async () => {
    seedOrder({ status: "pending" });

    await cancelOrder({ orderId: "order-1", customerId: "cust-1" });

    const [select] = txQuery.mock.calls[0] as [
      { text: string; values: unknown[] }
    ];
    expect(select.text).toMatch(/customer_id = \?/);
    expect(select.text).toMatch(/FOR UPDATE/);
    expect(select.values).toEqual(["order-1", "cust-1"]);
    // Nothing goes through the non-transactional query helper.
    expect(mockedQuery).not.toHaveBeenCalled();
  });
});
