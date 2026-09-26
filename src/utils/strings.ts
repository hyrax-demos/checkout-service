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
