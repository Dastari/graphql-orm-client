import { createHash } from "node:crypto"
import {
  Kind,
  getNamedType,
  isAbstractType,
  isEnumType,
  isInputObjectType,
  isListType,
  isNonNullType,
  isObjectType,
  isScalarType,
  parse,
  typeFromAST,
  type GraphQLInputType,
  type GraphQLNamedType,
  type GraphQLOutputType,
  type GraphQLSchema,
  type OperationDefinitionNode,
} from "graphql"
import type { Selection, SelectionCondition } from "../artifact.js"
import { CompileError, compile, type CompileOptions, type LiveAreaReport } from "./compile.js"
import { hasDefault, printSchemaStable } from "./print.js"

export interface GenerateOptions extends CompileOptions {
  /** Emit a schema fingerprint for opt-in persistence; schema changes then affect --check. */
  readonly persistence?: boolean
  /** TypeScript types for custom scalars, e.g. `{ DateTime: "string", JSON: "unknown" }`. */
  readonly scalars?: Readonly<Record<string, string>>
  /** Module the generated file imports runtime types from. Default `graphql-orm-client`. */
  readonly importFrom?: string
  /**
   * Receives one line per `live: { default: [...] }` pattern saying what it covered, for example
   * `live.default "src/area/**": 3 files, 11 fragments: 4 newly live, 5 opted out, 1 keyless, 1 without a stream`.
   * Default `console.log`. Not called under any other live setting.
   */
  readonly onSummary?: (line: string) => void
}

/** One line for a `live.default` pattern's report. */
function formatLiveArea(report: LiveAreaReport): string {
  const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`
  const outcomes = [
    `${report.newlyLive.length} newly live`,
    ...([["alreadyLive", "already live"], ["optedOut", "opted out"], ["keyless", "keyless"], ["withoutStream", "without a stream"], ["abstract", "on an interface or union"]] as const)
      .filter(([key]) => report[key].length).map(([key, label]) => `${report[key].length} ${label}`),
  ]
  return `live.default "${report.pattern}": ${count(report.files.length, "file", "files")}, ${count(report.fragments.length, "fragment", "fragments")}: ${outcomes.join(", ")}`
}

const BUILT_IN_SCALARS: Record<string, string> = {
  ID: "string",
  String: "string",
  Int: "number",
  Float: "number",
  Boolean: "boolean",
}

const OPERATION_SUFFIX = { query: "Query", mutation: "Mutation", subscription: "Subscription" } as const

/** One selection of a response key; `optional` when its `@skip`/`@include`, or an enclosing one, can leave it out. */
type Part = { readonly selections: readonly Selection[]; readonly optional: boolean }

/** `optional`: every selection of the response key can be left out. */
type Member =
  | { readonly kind: "scalar"; readonly ts: string; readonly optional: boolean }
  | { kind: "link"; readonly type: GraphQLOutputType; readonly types: readonly string[]; parts: Part[]; batch?: boolean; optional: boolean }

/** Whether a selection's `@skip`/`@include` can leave it out: not when every condition is a literal that keeps it. */
function mayLeaveOut(conditions: readonly SelectionCondition[] | undefined): boolean {
  return conditions?.some((condition) => typeof condition.if !== "boolean" || condition.if !== (condition.directive === "include")) === true
}

/**
 * Generate a TypeScript module from the documents in an application's `graphql(...)` calls.
 * Each source must hold exactly one operation or fragment. The module exports a typed artifact
 * per definition, the compiled live artifacts, and a `graphql()` function whose overloads map
 * each exact source to its artifact.
 */
export function generate(schema: GraphQLSchema, sources: readonly string[], options: GenerateOptions = {}): string {
  const unique = [...new Set(sources)]
  const definitions = new Map<string, { kind: "fragment" | keyof typeof OPERATION_SUFFIX; name: string }>()
  const variableDefinitions = new Map<string, OperationDefinitionNode>()
  const problems: string[] = []
  for (const source of unique) {
    const document = parse(source)
    if (document.definitions.length !== 1) {
      problems.push(`Each graphql() call must hold exactly one operation or fragment:\n${source.trim().slice(0, 120)}`)
      continue
    }
    const [definition] = document.definitions
    if (definition?.kind === Kind.FRAGMENT_DEFINITION) {
      definitions.set(source, { kind: "fragment", name: definition.name.value })
    } else if (definition?.kind === Kind.OPERATION_DEFINITION && definition.name) {
      definitions.set(source, { kind: definition.operation, name: definition.name.value })
      variableDefinitions.set(definition.name.value, definition)
    } else {
      problems.push(`Every operation needs a name:\n${source.trim().slice(0, 120)}`)
    }
  }
  if (problems.length) throw new CompileError(problems)

  const compiled = compile(schema, unique, { ...options, onWarning: options.onWarning ?? console.warn })
  for (const area of compiled.liveAreas ?? []) (options.onSummary ?? console.log)(formatLiveArea(area))
  const scalars = { ...BUILT_IN_SCALARS, ...options.scalars }
  const named = new Map<string, string>()

  const leaf = (type: GraphQLNamedType): string => {
    if (isScalarType(type)) return scalars[type.name] ?? "unknown"
    if (isEnumType(type)) {
      if (!named.has(type.name))
        named.set(
          type.name,
          `export type ${type.name} = ${type.getValues().map((value) => JSON.stringify(value.name)).join(" | ") || "never"}`
        )
      return type.name
    }
    return "unknown"
  }

  const wrapOutput = (type: GraphQLOutputType, inner: string): string => {
    if (isNonNullType(type)) return wrapNonNull(type.ofType, inner)
    return `${wrapNonNull(type, inner)} | null`
  }
  const wrapNonNull = (type: GraphQLOutputType, inner: string): string =>
    isListType(type) ? `ReadonlyArray<${wrapOutput(type.ofType, inner)}>` : inner

  // When a key is selected more than once and only some selections are conditional, the fields only those select are optional.
  const objectType = (typenames: readonly string[], parts: readonly Part[]): string => {
    const variants = typenames.map((typename) => {
      const members = new Map<string, Member>()
      // Each spread, and whether its `@skip`/`@include` can leave it out.
      const refs = new Map<string, boolean>()
      for (const part of parts) collect(typename, part.selections, members, refs, parts.length > 1 && part.optional)
      const fields = [...members].map(([key, member]) => {
        const name = `readonly ${key}${member.optional ? "?" : ""}`
        if (member.kind === "scalar") return `${name}: ${member.ts}`
        return `${name}: ${member.batch ? `RelationState<${objectType(member.types, member.parts)}>` : wrapOutput(member.type, objectType(member.types, member.parts))}`
      })
      const body = `{ ${fields.join("; ")}${fields.length ? " " : ""}}`
      const always = [...refs].filter(([, optional]) => !optional).map(([ref]) => ref).sort()
      // A spread its condition can leave out is either there or not: narrow it with `hasFragment`.
      const maybe = [...refs].filter(([, optional]) => optional).map(([ref]) => ref).sort()
      return [body, ...(always.length ? [`FragmentRefs<${always.map((ref) => JSON.stringify(ref)).join(" | ")}>`] : []), ...maybe.map((ref) => `({} | FragmentRefs<${JSON.stringify(ref)}>)`)].join(" & ")
    })
    return variants.length === 1 ? variants[0]! : `(${variants.join(" | ")})`
  }

  const collect = (typename: string, selections: readonly Selection[], members: Map<string, Member>, refs: Map<string, boolean>, conditional: boolean) => {
    const type = schema.getType(typename)
    const fields = type && isObjectType(type) ? type.getFields() : {}
    for (const selection of selections) {
      const optional = conditional || mayLeaveOut(selection.conditions)
      // A key selected once without a condition is always there.
      const existingOptional = members.get((selection as { responseKey?: string }).responseKey ?? "")?.optional ?? true
      if (selection.kind === "scalar") {
        if (selection.fieldName === "__typename") {
          members.set(selection.responseKey, { kind: "scalar", ts: JSON.stringify(typename), optional: optional && existingOptional })
          continue
        }
        const field = fields[selection.fieldName]
        if (!field) continue
        members.set(selection.responseKey, { kind: "scalar", ts: wrapOutput(field.type, leaf(getNamedType(field.type))), optional: optional && existingOptional })
      } else if (selection.kind === "link") {
        const field = fields[selection.fieldName]
        if (!field) continue
        const existing = members.get(selection.responseKey)
        const part = { selections: selection.selections, optional }
        if (existing?.kind === "link") {
          existing.parts.push(part)
          existing.optional &&= optional
        } else members.set(selection.responseKey, { kind: "link", batch: !!selection.batch, type: field.type, types: selection.types, parts: [part], optional })
      } else if (selection.kind === "inline") {
        if (selection.possibleTypes === null || selection.possibleTypes.includes(typename))
          collect(typename, selection.selections, members, refs, optional)
      } else if (selection.possibleTypes.includes(typename)) {
        refs.set(selection.name, (refs.get(selection.name) ?? true) && optional)
      }
    }
  }

  const inputType = (type: GraphQLInputType): string => {
    if (isNonNullType(type)) return inputType(type.ofType).replace(/ \| null$/, "")
    if (isListType(type)) return `ReadonlyArray<${inputType(type.ofType)}> | null`
    const namedType = getNamedType(type)
    if (isInputObjectType(namedType)) {
      if (!named.has(namedType.name)) {
        named.set(namedType.name, "")
        const fields = Object.values(namedType.getFields()).map((field) => {
          // A non-null field with a default may be left out (the default applies), but an explicit null is invalid.
          const optional = !isNonNullType(field.type) || hasDefault(field)
          return `readonly ${field.name}${optional ? "?" : ""}: ${inputType(field.type)}`
        })
        named.set(namedType.name, `export type ${namedType.name} = { ${fields.join("; ")}${fields.length ? " " : ""}}`)
      }
      return `${namedType.name} | null`
    }
    return `${leaf(namedType)} | null`
  }

  const lines: string[] = []
  const typeNameOf = (definition: { kind: string; name: string }) =>
    definition.kind === "fragment"
      ? `${definition.name}Fragment`
      : `${definition.name}${OPERATION_SUFFIX[definition.kind as keyof typeof OPERATION_SUFFIX]}`

  for (const definition of [...definitions.values()].sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const typeName = typeNameOf(definition)
    if (definition.kind === "fragment") {
      const fragment = compiled.fragments[definition.name]!
      const type = schema.getType(fragment.typeCondition)!
      const typenames = isAbstractType(type) ? schema.getPossibleTypes(type).map((entry) => entry.name).sort() : [type.name]
      lines.push(`export type ${typeName} = ${objectType(typenames, [{ selections: fragment.selections, optional: false }])}`)
      lines.push(
        `export const ${typeName} = ${JSON.stringify(fragment)} as unknown as FragmentArtifact<${typeName}, ${JSON.stringify(definition.name)}>`
      )
    } else {
      const operation = compiled.operations[definition.name]!
      const node = variableDefinitions.get(definition.name)!
      const variables = (node.variableDefinitions ?? []).map((variable) => {
        const type = typeFromAST(schema, variable.type) as GraphQLInputType
        const optional = !isNonNullType(type) || variable.defaultValue !== undefined
        return `readonly ${variable.variable.name.value}${optional ? "?" : ""}: ${inputType(type)}`
      })
      lines.push(`export type ${definition.name}Variables = { ${variables.join("; ")}${variables.length ? " " : ""}}`)
      lines.push(`export type ${typeName} = ${objectType([operation.rootType], [{ selections: operation.selections, optional: false }])}`)
      lines.push(
        `export const ${typeName} = ${JSON.stringify(operation)} as unknown as OperationArtifact<${typeName}, ${definition.name}Variables>`
      )
    }
  }

  const overloads = [...definitions].map(
    ([source, definition]) => `export function graphql(source: ${JSON.stringify(source)}): typeof ${typeNameOf(definition)}`
  )
  const table = [...definitions].map(([source, definition]) => `  [${JSON.stringify(source)}]: ${typeNameOf(definition)},`)
  const importFrom = options.importFrom ?? "graphql-orm-client"
  return [
    "/* eslint-disable */",
    "// Generated by graphql-orm-client. Do not edit; run the generator again.",
    `import type { FragmentArtifact, FragmentRefs, LiveArtifact, OperationArtifact, RelationState } from ${JSON.stringify(importFrom)}`,
    "",
    ...[...named.values()].filter(Boolean).sort(),
    "",
    ...(options.persistence ? [
      `/** Schema fingerprint for persistence envelopes. */`,
      `export const schemaHash = ${JSON.stringify(createHash("sha256").update(printSchemaStable(schema)).digest("hex"))}`,
    ] : []),
    ...lines,
    "",
    `/** Live subscriptions per type; pass to createClient({ live: { artifacts: live, ... } }). */`,
    `export const live = ${JSON.stringify(compiled.live)} as unknown as Readonly<Record<string, LiveArtifact>>`,
    `/** Types with live fragments but no usable Changed subscription; their holders must poll. */`,
    `export const liveUnavailable: readonly string[] = ${JSON.stringify(compiled.liveUnavailable)}`,
    "",
    `const documents: Record<string, unknown> = {`,
    ...table,
    `}`,
    "",
    ...overloads,
    `export function graphql(source: string): unknown {`,
    `  const artifact = documents[source]`,
    `  if (!artifact) throw new Error("This GraphQL document was not generated; run the generator again")`,
    `  return artifact`,
    `}`,
    "",
  ].join("\n")
}
