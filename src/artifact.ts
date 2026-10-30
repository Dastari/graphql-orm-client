/**
 * Compiled artifacts. The compiler produces them from GraphQL documents at build time; the runtime
 * never parses GraphQL. They are plain JSON so a codegen step can write them to disk.
 */

/** A field argument: a literal value or a reference to an operation variable. */
export type ArgumentSpec =
  | { readonly kind: "literal"; readonly name: string; readonly value: unknown }
  | { readonly kind: "variable"; readonly name: string; readonly variable: string }
  | { readonly kind: "object"; readonly name: string; readonly fields: readonly ArgumentSpec[] }
  | { readonly kind: "list"; readonly name: string; readonly items: readonly ArgumentSpec[] }

export interface ScalarSelection {
  readonly kind: "scalar"
  readonly responseKey: string
  readonly fieldName: string
  readonly args: readonly ArgumentSpec[]
}

export interface LinkSelection {
  readonly kind: "link"
  readonly responseKey: string
  readonly fieldName: string
  readonly args: readonly ArgumentSpec[]
  readonly plural: boolean
  /** Concrete types the field can return. */
  readonly types: readonly string[]
  readonly selections: readonly Selection[]
}

export interface InlineFragmentSelection {
  readonly kind: "inline"
  /** null for an inline fragment without a type condition. */
  readonly typeCondition: string | null
  /** Concrete types the condition matches; null when there is no condition. */
  readonly possibleTypes: readonly string[] | null
  readonly selections: readonly Selection[]
}

/** A spread of another fragment. Readers return a masked reference; normalisers inline it. */
export interface FragmentSpreadSelection {
  readonly kind: "spread"
  readonly name: string
  readonly typeCondition: string
  readonly possibleTypes: readonly string[]
}

export type Selection =
  | ScalarSelection
  | LinkSelection
  | InlineFragmentSelection
  | FragmentSpreadSelection

/**
 * Type-only marker for masked fragment references: an object that a spread of fragment `N`
 * produced. Only `readFragment`, `useFragment` and `useFragmentList` read through it.
 */
export type FragmentRefs<N extends string> = {
  readonly " $fragmentRefs": { readonly [K in N]: true }
}

/**
 * The reference a fragment accepts: a typed fragment (literal name) requires a reference from a
 * spread of that fragment; an untyped artifact (`string` name) accepts any value.
 */
export type FragmentRefFor<N extends string> = string extends N ? unknown : FragmentRefs<N>

export interface FragmentArtifact<TData = unknown, TName extends string = string> {
  /** Type-only: the fragment's own data. */
  readonly " $data"?: TData
  readonly kind: "fragment"
  readonly name: TName
  readonly typeCondition: string
  /** What `readFragment` and `useFragment` return: only this fragment's own fields. */
  readonly selections: readonly Selection[]
  /** Whether the fragment is marked `@live`. */
  readonly live: boolean
}

export interface OperationArtifact<TData = unknown, TVariables = Record<string, unknown>> {
  /** Type-only: the root's data and variables. */
  readonly " $types"?: { readonly data: TData; readonly variables: TVariables }
  readonly kind: "query" | "mutation" | "subscription"
  readonly name: string
  /** The operation text with every fragment it uses, as sent to the server. */
  readonly text: string
  /** sha256 of `text`, hex; the persisted-operation identity. */
  readonly hash: string
  readonly rootType: string
  /** What the root reads: its own fields, with child fragments as masked references. */
  readonly selections: readonly Selection[]
  /** Every field the response contains, fragments inlined: what the normaliser walks. */
  readonly normalization: readonly Selection[]
  /** Key fields per concrete type, in primary-key order. */
  readonly keys: Readonly<Record<string, readonly string[]>>
  /** Record-version field per type, where the type has one. */
  readonly versions: Readonly<Record<string, string>>
  /** Fragments referenced anywhere in this operation, by name. */
  readonly fragments: Readonly<Record<string, FragmentArtifact>>
}

/**
 * How a type's generated `<Type>Changed` subscription can be narrowed to the records on screen:
 * - `keys`: one subscription per type with a bounded `Keys` list;
 * - `key`: one subscription per record with `Key`;
 * - `unkeyed`: one subscription per type; the client ignores records it does not hold.
 */
export type LiveMode = "keys" | "key" | "unkeyed"

export interface LiveArtifact {
  readonly typename: string
  readonly mode: LiveMode
  /** The subscription field, e.g. `DeviceChanged`. */
  readonly field: string
  /** The payload field holding the changed entity. */
  readonly entityField: string
  /** The payload field holding CREATED / UPDATED / DELETED. */
  readonly actionField: string
  /** The argument and variable name for keys (`Keys` or `Key`); null when unkeyed. */
  readonly keyArgument: string | null
  /** The key fields in primary-key order; composite keys are sent as input objects. */
  readonly keyFields: readonly string[]
  /** The subscription to run, selecting every `@live` fragment on the type. */
  readonly operation: OperationArtifact
}

export type Artifact = OperationArtifact | FragmentArtifact | LiveArtifact
