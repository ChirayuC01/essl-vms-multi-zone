// Saved identity numbers are only ever shown masked (CLAUDE.md #12): the
// first two and last two characters, the rest as `*`. The full value stays in
// the database for uniqueness and returning-visitor matching, and nowhere else.

export function maskId(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (value.length <= 4) return "*".repeat(value.length);
  return `${value.slice(0, 2)}${"*".repeat(value.length - 4)}${value.slice(-2)}`;
}

/** A value the console echoed back masked means "unchanged", never a new number. */
export function isMasked(value: unknown): boolean {
  return typeof value === "string" && value.includes("*");
}
