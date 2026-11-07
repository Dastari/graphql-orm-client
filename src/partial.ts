import type { GraphQLErrorLike } from "./client.js"

/** Errors at or below a response alias/path; pathless errors affect the whole operation. */
export function errorsAtPath(errors: readonly GraphQLErrorLike[], path: readonly (string | number)[]): readonly GraphQLErrorLike[] {
  return errors.filter(error => !error.path || path.every((part, index) => error.path![index] === part)
    || error.path.every((part, index) => path[index] === part))
}

/**
 * Omit only nulls implicated by error paths, including null-bubbled ancestors. Successful nulls
 * remain real writes. The caller's response is never mutated.
 */
export function withoutErrorNulls(data: Record<string, unknown>, errors: readonly GraphQLErrorLike[]): Record<string, unknown> {
  const omit = Symbol("omit")
  const walk = (value: unknown, path: readonly (string | number)[]): unknown => {
    if (value === null && errors.some(e => e.path && path.every((part, index) => e.path![index] === part)))
      return omit
    if (Array.isArray(value)) {
      const items = value.map((item, index) => walk(item, [...path, index]))
      // A connection/list cannot safely splice a refused position or invent its identity.
      return items.includes(omit) ? omit : items
    }
    if (value && typeof value === "object") {
      const copy: Record<string, unknown> = {}
      for (const [key, child] of Object.entries(value)) {
        const next = walk(child, [...path, key])
        if (next !== omit) copy[key] = next
      }
      return copy
    }
    return value
  }
  return walk(data, []) as Record<string, unknown>
}
