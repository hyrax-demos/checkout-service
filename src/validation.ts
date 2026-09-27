// Shared request-input validators.
//
// Each validator is a type guard over `unknown`, so a route can check a raw
// `req.body` field and use it as the narrowed type afterwards. The validators
// only answer "is this value acceptable?". Each route still owns its error
// message and status code, so those stay the same wherever a validator is
// used.

/**
 * A strictly positive whole number of cents that is a JS safe integer.
 * Rejects numeric strings, fractions, zero, negatives, NaN and Infinity.
 */
export function isPositiveIntegerCents(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

/**
 * A number greater than zero. Unlike `isPositiveIntegerCents`, fractions are
 * allowed, so it suits dollar-denominated inputs. Rejects NaN and non-numbers.
 */
export function isPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && value > 0;
}

/** A string with at least one character. */
export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** An array with at least one element (of any type). */
export function isNonEmptyArray(value: unknown): value is unknown[] {
  return Array.isArray(value) && value.length > 0;
}

/** An array with at least one element, where every element is a non-empty string. */
export function isNonEmptyStringArray(value: unknown): value is string[] {
  return isNonEmptyArray(value) && value.every(isNonEmptyString);
}
