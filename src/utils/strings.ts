// Separator used between words in a slug.
export const SLUG_SEPARATOR = "-";

// Convert arbitrary text into a URL-friendly slug: lowercased, trimmed, with
// every run of non-alphanumeric characters collapsed to a single separator and
// no leading/trailing separators.
export function slugify(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, SLUG_SEPARATOR)
    .split(SLUG_SEPARATOR)
    .filter((part) => part.length > 0)
    .join(SLUG_SEPARATOR);
}

// Shorten `s` to at most `n` characters, appending an ellipsis ("…") when
// truncation occurs. The ellipsis counts toward the n-character budget.
// Strings of length <= n are returned unchanged; n === 0 yields "".
// Throws RangeError when n is negative.
export function truncate(s: string, n: number): string {
  if (n < 0) {
    throw new RangeError(`truncate: n must be >= 0, got ${n}`);
  }
  if (s.length <= n) {
    return s;
  }
  if (n === 0) {
    return "";
  }
  return s.slice(0, n - 1) + "…";
}
