// Pure discount helpers for order item subtotals. Amounts are integer cents,
// matching the `Order.total` convention in ../types. Nothing here does I/O,
// reads global state, or mutates its arguments.

function assertValidPercent(percent: unknown): asserts percent is number {
  if (
    typeof percent !== "number" ||
    !Number.isInteger(percent) ||
    percent < 0 ||
    percent > 100
  ) {
    throw new Error(
      `invalid discount percent: ${String(percent)} (must be an integer from 0 to 100)`
    );
  }
}

/**
 * Return the single best (highest) discount percentage, or 0 when the list is
 * empty. Every entry must be an integer from 0 to 100 inclusive; otherwise an
 * Error is thrown.
 */
export function bestDiscountPercent(discountPercents: readonly number[]): number {
  let best = 0;
  for (const percent of discountPercents) {
    assertValidPercent(percent);
    if (percent > best) best = percent;
  }
  return best;
}

/**
 * Apply the best available percentage discount to an item subtotal.
 *
 * Semantics:
 * - Discounts are integer percentages from 0 to 100 inclusive. Any other value
 *   (non-integer, NaN, below 0, above 100) throws an Error.
 * - Discounts do not stack: only the highest percentage applies. An empty list
 *   returns the subtotal unchanged.
 * - The discount applies to the item subtotal only (before tax and shipping);
 *   this helper knows nothing about tax or shipping.
 * - Rounding is half-up to a whole cent using integer arithmetic only:
 *   `discount = floor((subtotalCents * percent + 50) / 100)`. For example, 5
 *   cents at 10% is a 0.5-cent discount, which rounds up to 1, giving 4.
 * - The result is clamped: `max(0, subtotalCents - discount)`.
 *
 * Negative subtotal policy: rejected. `subtotalCents` must be a non-negative
 * safe integer; a negative, fractional, or unsafe value throws an Error.
 *
 * @param subtotalCents item subtotal in integer cents
 * @param discountPercents candidate discount percentages (not mutated)
 * @returns the discounted subtotal in integer cents
 */
export function applyDiscount(
  subtotalCents: number,
  discountPercents: readonly number[]
): number {
  if (!Number.isSafeInteger(subtotalCents) || subtotalCents < 0) {
    throw new Error(
      `invalid subtotal: ${String(subtotalCents)} (must be a non-negative integer number of cents)`
    );
  }
  const percent = bestDiscountPercent(discountPercents);
  if (percent === 0) return subtotalCents;

  // BigInt keeps the multiplication exact even for subtotals near
  // Number.MAX_SAFE_INTEGER; BigInt division truncates, which equals floor
  // here because both operands are non-negative.
  const discountCents = Number(
    (BigInt(subtotalCents) * BigInt(percent) + 50n) / 100n
  );
  return Math.max(0, subtotalCents - discountCents);
}
