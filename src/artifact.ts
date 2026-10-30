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

export interface FragmentArtifact {
  readonly kind: "fragment"
  readonly name: string
  readonly typeCondition: string
  /** What `readFragment` and `useFragment` return: only this fragment's own fields. */
  readonly selections: readonly Selection[]
  /** Whether the fragment is marked `@live`. */
  readonly live: boolean
}

export interface OperationArtifact {
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

export type Artifact = OperationArtifact | FragmentArtifact
