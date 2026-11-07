/** Explicit lifetime semantics; sqlite-utc asserts the service stores UTC without a zone. */
export interface LifetimePolicy {
  readonly field: string
  readonly format: "unix-seconds" | "rfc3339" | "sqlite-utc"
}
/** Unknown includes absent, null, malformed and ambiguous time values. */
export type LifetimeState = "valid" | "expired" | "unknown"
/** Parse only the declared representation; never infer units or a timezone. */
export function lifetimeTime(value: unknown, format: LifetimePolicy["format"]): number | null {
  if (format === "unix-seconds") {
    if (typeof value !== "number" && !(typeof value === "string" && /^-?\d+(?:\.\d+)?$/.test(value))) return null
    const ms = Number(value) * 1000
    return Number.isFinite(ms) && Math.abs(ms) <= 8.64e15 ? ms : null
  }
  if (typeof value !== "string") return null
  const sqlite = format === "sqlite-utc"
  if (sqlite ? !/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(value) : !/^\d{4}-\d\d-\d\d[Tt]\d\d:\d\d:\d\d(?:\.\d+)?(?:[Zz]|[+-]\d\d:\d\d)$/.test(value)) return null
  const parts = value.match(/^(\d{4})-(\d\d)-(\d\d)[Tt ](\d\d):(\d\d):(\d\d)/)!
  const [, y, m, d, h, min, sec] = parts.map(Number)
  const days = new Date(Date.UTC(y!, m!, 0)).getUTCDate()
  if (m! < 1 || m! > 12 || d! < 1 || d! > days || h! > 23 || min! > 59 || sec! > 59) return null
  const ms = Date.parse(sqlite ? value.replace(" ", "T") + "Z" : value)
  return Number.isFinite(ms) ? ms : null
}
