# Refund endpoint does not check order ownership — any authenticated user can refund any order

**Tool:** `mini_audit`
**Severity:** critical
**Category:** security
**Location:** `src/routes/payments.ts:53`

## What's wrong

The `/refunds` handler fetches the order by `reference` alone (`WHERE reference = $1`) without constraining to `customer_id = req.userId`. Any authenticated user who knows (or guesses) another customer's order reference can trigger a refund on that order. The fix is to add `AND customer_id = $2` with `req.userId` as the second parameter, matching the pattern used in the orders and charge endpoints.
