import type { OperationArtifact, Selection } from "./artifact.js"
import type { GraphQLErrorLike } from "./client.js"
import { identify } from "./store/normalize.js"

/** A field the operation selects that the response leaves out. */
export interface MissingField {
  /** The response path to the field, with list indices. */
  readonly path: readonly (string | number)[]
  readonly typename: string
  /** The record's NodeId, or null for the root or an object without a complete key. */
  readonly record: string | null
  readonly responseKey: string
}

const marked = new WeakMap<OperationArtifact<any, any>, boolean>()

function hasConditional(selections: readonly Selection[]): boolean {
  return selections.some((selection) => selection.conditional === true || ((selection.kind === "link" || selection.kind === "inline") && hasConditional(selection.selections)))
}

/**
 * Whether a response to this operation can be checked for left-out fields. A module generated before conditional selections were
 * marked can't tell a field `@skip` left out from one the server dropped, so one whose text uses `@skip` or `@include` isn't checked.
 */
function checkable(artifact: OperationArtifact<any, any>): boolean {
  let result = marked.get(artifact)
  if (result === undefined) {
    result = !/@(skip|include)\b/.test(artifact.text) || hasConditional(artifact.normalization)
    marked.set(artifact, result)
  }
  return result
}

/**
 * The fields the operation selects that `data` leaves out. A null is a value, not a left-out field. Fields under a legacy `@skip`
 * or `@include`, `@batch` relations (read separately) and fields at or below a path an error names are not reported.
 */
export function missingFields(artifact: OperationArtifact<any, any>, data: Record<string, unknown>, errors: readonly GraphQLErrorLike[]): MissingField[] {
  if (!checkable(artifact)) return []
  const found: MissingField[] = []
  const errorPaths = errors.flatMap((error) => (error.path ? [error.path] : []))
  const reported = (path: readonly (string | number)[]) =>
    errorPaths.some((errorPath) => errorPath.length <= path.length && errorPath.every((part, index) => path[index] === part))
  const walk = (selections: readonly Selection[], value: Record<string, unknown>, typename: string, record: string | null, path: readonly (string | number)[]): void => {
    for (const selection of selections) {
      if (selection.conditional) continue
      if (selection.kind === "inline") {
        if (selection.possibleTypes === null || selection.possibleTypes.includes(typename)) walk(selection.selections, value, typename, record, path)
        continue
      }
      if (selection.kind === "spread" || (selection.kind === "link" && selection.batch)) continue
      const key = selection.responseKey
      const at = [...path, key]
      if (!(key in value)) {
        if (selection.kind === "scalar" && selection.fieldName === "__typename") continue
        if (!reported(at)) found.push({ path: at, typename, record, responseKey: key })
        continue
      }
      if (selection.kind !== "link") continue
      const child = value[key]
      if (Array.isArray(child)) child.forEach((item, index) => object(selection.selections, item, [...at, index]))
      else object(selection.selections, child, at)
    }
  }
  const object = (selections: readonly Selection[], value: unknown, path: readonly (string | number)[]) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return
    const item = value as Record<string, unknown>
    const typename = typeof item.__typename === "string" ? item.__typename : "?"
    walk(selections, item, typename, identify(item, artifact.keys), path)
  }
  walk(artifact.normalization, data, artifact.rootType, null, [])
  return found
}

/** The warning for a left-out field. */
export function missingFieldMessage(operation: string, field: MissingField): string {
  return `${operation}: the response has no "${field.responseKey}" on ${field.typename}${field.record ? ` ${field.record}` : ""} at ${field.path.join(".")}, which the operation selects; its data is incomplete. Check the server and any gateway, or regenerate. [missingFields]`
}

/** The code of the error `missingFields: "error"` reports. */
export const RESPONSE_FIELD_MISSING = "RESPONSE_FIELD_MISSING"
