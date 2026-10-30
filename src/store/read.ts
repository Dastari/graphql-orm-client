import type { Selection } from "../artifact.js"
import { storageKey } from "./arguments.js"
import { ROOT_ID, type Selector, type Store, type StoredLink, type StoredLinks } from "./store.js"

/** Hidden on every object that carries masked fragment references. */
export const FRAGMENT_REF = Symbol.for("graphql-orm-client.fragmentRef")

export interface FragmentRefData {
  readonly id: string
  readonly fragments: ReadonlySet<string>
  readonly store: Store
  readonly variables: Readonly<Record<string, unknown>>
}

export interface ReadResult<T = unknown> {
  readonly data: T
  /** True when a selected field is absent from the store and must be fetched. */
  readonly missing: boolean
  /** Every record id read, so the store knows which writes affect this snapshot. */
  readonly seen: ReadonlySet<string>
}

interface ReadOptions {
  /** Read fragment spreads as if inlined (used for garbage-collection marking). */
  readonly inlineSpreads?: boolean
  /** Collects the root-record keys read (used for garbage collection). */
  readonly rootKeys?: Set<string>
  /** Called for every fragment spread that applies to a record. */
  readonly onSpread?: (fragment: string, id: string, typename: string) => void
}

function isLink(value: unknown): value is StoredLink {
  return typeof value === "object" && value !== null && "__ref" in value
}

function isLinks(value: unknown): value is StoredLinks {
  return typeof value === "object" && value !== null && "__refs" in value
}

export function readSelections<T>(store: Store, selector: Selector, options: ReadOptions = {}): ReadResult<T> {
  const seen = new Set<string>()
  let missing = false

  const readRecord = (id: string, selections: readonly Selection[]): Record<string | symbol, unknown> | null | undefined => {
    seen.add(id)
    const record = store.get(id)
    if (!record) {
      missing = true
      return undefined
    }
    const data: Record<string | symbol, unknown> = {}
    readInto(data, record.__id, record.__typename, selections)
    return data
  }

  const readInto = (
    data: Record<string | symbol, unknown>,
    id: string,
    typename: string,
    selections: readonly Selection[]
  ): void => {
    const record = store.get(id)!
    for (const selection of selections) {
      switch (selection.kind) {
        case "scalar": {
          if (selection.fieldName === "__typename") {
            data[selection.responseKey] = typename
            break
          }
          const key = storageKey(selection.fieldName, selection.args, selector.variables)
          if (id === ROOT_ID) options.rootKeys?.add(key)
          if (!record.fields.has(key)) {
            missing = true
            break
          }
          data[selection.responseKey] = record.fields.get(key)
          break
        }
        case "link": {
          const key = storageKey(selection.fieldName, selection.args, selector.variables)
          if (id === ROOT_ID) options.rootKeys?.add(key)
          if (!record.fields.has(key)) {
            missing = true
            break
          }
          const value = record.fields.get(key)
          if (value === null) {
            data[selection.responseKey] = null
          } else if (isLink(value)) {
            data[selection.responseKey] = readRecord(value.__ref, selection.selections)
          } else if (isLinks(value)) {
            data[selection.responseKey] = value.__refs.map((ref) =>
              ref === null ? null : readRecord(ref, selection.selections)
            )
          } else {
            missing = true
          }
          break
        }
        case "inline": {
          if (selection.possibleTypes === null || selection.possibleTypes.includes(typename))
            readInto(data, id, typename, selection.selections)
          break
        }
        case "spread": {
          if (!selection.possibleTypes.includes(typename)) break
          options.onSpread?.(selection.name, id, typename)
          if (options.inlineSpreads) {
            const fragment = selector.fragments[selection.name]
            if (fragment) readInto(data, id, typename, fragment.selections)
            break
          }
          const existing = data[FRAGMENT_REF] as FragmentRefData | undefined
          const fragments = new Set(existing?.fragments ?? [])
          fragments.add(selection.name)
          Object.defineProperty(data, FRAGMENT_REF, {
            value: { id, fragments, store, variables: selector.variables } satisfies FragmentRefData,
            enumerable: false,
            configurable: true,
          })
          break
        }
      }
    }
  }

  const data = readRecord(selector.id, selector.selections)
  return { data: (data ?? null) as T, missing, seen }
}
