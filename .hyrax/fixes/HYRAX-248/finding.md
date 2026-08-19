# SQL injection via string interpolation in all orders query handlers

**Tool:** `database`
**Severity:** critical
**Category:** architecture
**Location:** `src/routes/orders.ts:10`

## What's wrong

All three query sites in `orders.ts` and the refund lookup in `payments.ts` build SQL strings by directly interpolating user-supplied values (`req.params.id`, `req.query.customerId`, `req.body.customerId`, `req.body.reference`) into raw SQL strings using template literals. This is classic SQL injection — an attacker can exfiltrate or corrupt the entire database. The `query()` helper accepts a plain string and passes it directly to `pool.query()` with no parameter binding. The `queryParams()` helper exists and is correctly used elsewhere (e.g., `UPDATE orders SET status`), confirming the dev team knows the right pattern — but the read and insert paths were never converted. In a PCI-DSS context this is a critical data breach risk.
