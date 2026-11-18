import type { ArgumentSpec, ConnectionSpec, FragmentArgumentSpec, SelectionCondition } from "../artifact.js"

export type Variables = Readonly<Record<string, unknown>>

function resolve(spec: ArgumentSpec, variables: Variables): unknown {
  switch (spec.kind) {
    case "literal":
      return spec.value
    case "variable":
      // A fragment's own argument (`Fragment.name`) can be unbound, and is then absent. An unset operation variable is null.
      return spec.variable.includes(".") ? variables[spec.variable] : variables[spec.variable] ?? null
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
 * selections of `Widgets(Where: …)` with different filters are different stored lists.
 */
export function storageKey(
  fieldName: string,
  args: readonly ArgumentSpec[],
  variables: Variables
): string {
  if (args.length === 0) return fieldName
  // An argument given an unbound fragment argument isn't sent, so it isn't part of the key.
  const resolved = Object.fromEntries(args.map((arg) => [arg.name, resolve(arg, variables)]).filter(([, value]) => value !== undefined))
  return Object.keys(resolved).length ? `${fieldName}(${stableStringify(resolved)})` : fieldName
}

/** The storage key of a selected field; a connection leaves out its paging arguments. */
export function fieldStorageKey(
  selection: { readonly fieldName: string; readonly args: readonly ArgumentSpec[]; readonly connection?: ConnectionSpec },
  variables: Variables
): string {
  if (!selection.connection) return storageKey(selection.fieldName, selection.args, variables)
  const { paging, key } = selection.connection
  const args = selection.args.filter((arg) => !paging.includes(arg.name))
  return `${storageKey(selection.fieldName, args, variables)}@connection(${key})`
}

/**
 * The variables a fragment that declares arguments is read with: the spreading scope's, and each of the fragment's
 * arguments under `<Fragment>.<argument>`: what the spread passes, resolved in the spreading scope, else the default, else
 * undefined (unbound). The compiler names the fragment's own variables that way, so an operation variable of the same name
 * is never mistaken for one.
 */
export function fragmentScope(fragment: string, args: readonly FragmentArgumentSpec[], variables: Variables): Variables {
  const scope: Record<string, unknown> = { ...variables }
  for (const arg of args) {
    let value = arg.value ? resolve(arg.value, variables) : undefined
    if (value === undefined && "defaultValue" in arg) value = arg.defaultValue
    // Set even when unbound, so a value of the same fragment's from further out never shows through.
    scope[`${fragment}.${arg.name}`] = value
  }
  return scope
}

/** The resolved value of one argument, or undefined when the field doesn't take it. */
export function argumentValue(args: readonly ArgumentSpec[], name: string, variables: Variables): unknown {
  const spec = args.find((arg) => arg.name === name)
  return spec ? resolve(spec, variables) : undefined
}

/**
 * Whether a selection with these `@skip`/`@include` conditions applies under the variables. A variable left out takes the
 * default the operation declares, as on the server; an explicit null doesn't, and like a variable with neither counts as false
 * (the server refuses such a request).
 */
export function included(conditions: readonly SelectionCondition[] | undefined, variables: Variables): boolean {
  if (!conditions) return true
  for (const condition of conditions) {
    if ("anyOf" in condition) {
      if (!condition.anyOf.some((alternative) => included(alternative, variables))) return false
      continue
    }
    const test = condition.if
    const value = typeof test === "boolean" ? test : (variables[test.variable] === undefined ? test.default : variables[test.variable]) === true
    if (value !== (condition.directive === "include")) return false
  }
  return true
}
