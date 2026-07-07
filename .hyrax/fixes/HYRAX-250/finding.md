# Payment charge and order status update not wrapped in a transaction

**Tool:** `database`
**Severity:** high
**Category:** architecture
**Location:** `src/routes/payments.ts:18`

## What's wrong

The `/payments/charge` handler calls `chargeProcessor(...)` and then `queryParams('UPDATE orders SET status = $1 ...')` as two separate, uncoordinated operations. If the DB update fails after the payment has been charged, the order remains in `pending` state while money has been taken — a financial inconsistency. The catch block on line 23 silently swallows ALL errors and still returns `{ ok: true }`, meaning a DB update failure after a successful charge is invisible. Similarly `/refunds` has the same uncoordinated risk between refund and DB update. In a PCI-DSS-scoped checkout service, inconsistent payment state is a critical operational and compliance risk.
