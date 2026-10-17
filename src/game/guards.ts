/** Canonical object guard for campaign and storage modules: proves an object, not its fields. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
