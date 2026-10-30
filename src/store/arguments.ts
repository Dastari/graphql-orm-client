import type { ArgumentSpec } from "../artifact.js"

export type Variables = Readonly<Record<string, unknown>>

function resolve(spec: ArgumentSpec, variables: Variables): unknown {
  switch (spec.kind) {
    case "literal":
      return spec.value
    case "variable":
      return variables[spec.variable] ?? null
    case "object":
      return Object.fromEntries(spec.fields.map((field) => [field.name, resolve(field, variables)]))
    case "list":
      return spec.items.map((item) => resolve(item, variables))
  }
}

/** JSON with object keys sorted, so equal arguments always produce the same storage key. */
export function stableStringify(value: unknown): string {
  if (value === undefined) return "null"
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(",")}}`
}

/**
 * The key a field is stored under: its name, plus its resolved arguments when it has any. Two
 * selections of `Devices(Where: …)` with different filters are different stored lists.
 */
export function storageKey(
  fieldName: string,
  args: readonly ArgumentSpec[],
  variables: Variables
): string {
  if (args.length === 0) return fieldName
  const resolved = Object.fromEntries(args.map((arg) => [arg.name, resolve(arg, variables)]))
  return `${fieldName}(${stableStringify(resolved)})`
}
