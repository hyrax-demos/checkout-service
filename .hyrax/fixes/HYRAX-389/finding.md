# chargeIdempotencyKey includes Date.now() — defeats idempotency, enables double charges on retry

**Tool:** `concurrency`
**Severity:** critical
**Category:** correctness
**Location:** `src/utils/tokens.ts:17`

## What's wrong

`chargeIdempotencyKey()` returns `charge_${orderId}_${Date.now().toString(36)}`. Because `Date.now()` changes on every invocation, every call to the function generates a different key — even for the same `orderId`. The function's own comment states: "The processor collapses charges that share a key, so retries of the same attempt do not double-charge the customer." This invariant is violated: if a client retries a timed-out charge request, a new key is generated and the processor treats it as a fresh charge, double-billing the customer.
