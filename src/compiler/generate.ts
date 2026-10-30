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
import type { Selection } from "../artifact.js"
import { CompileError, compile, type CompileOptions } from "./compile.js"

export interface GenerateOptions extends CompileOptions {
  /** TypeScript types for custom scalars, e.g. `{ DateTime: "string", JSON: "unknown" }`. */
  readonly scalars?: Readonly<Record<string, string>>
  /** Module the generated file imports runtime types from. Default `graphql-orm-client`. */
  readonly importFrom?: string
}

const BUILT_IN_SCALARS: Record<string, string> = {
  ID: "string",
  String: "string",
  Int: "number",
  Float: "number",
  Boolean: "boolean",
}

const OPERATION_SUFFIX = { query: "Query", mutation: "Mutation", subscription: "Subscription" } as const

type Member =
  | { readonly kind: "scalar"; readonly ts: string }
  | { kind: "link"; readonly type: GraphQLOutputType; readonly types: readonly string[]; selections: Selection[] }

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

  const compiled = compile(schema, unique, options)
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

  const objectType = (typenames: readonly string[], selections: readonly Selection[]): string => {
    const variants = typenames.map((typename) => {
      const members = new Map<string, Member>()
      const refs = new Set<string>()
      collect(typename, selections, members, refs)
      const fields = [...members].map(([key, member]) => {
        if (member.kind === "scalar") return `readonly ${key}: ${member.ts}`
        return `readonly ${key}: ${wrapOutput(member.type, objectType(member.types, member.selections))}`
      })
      const body = `{ ${fields.join("; ")}${fields.length ? " " : ""}}`
      return refs.size ? `${body} & FragmentRefs<${[...refs].sort().map((ref) => JSON.stringify(ref)).join(" | ")}>` : body
    })
    return variants.length === 1 ? variants[0]! : `(${variants.join(" | ")})`
  }

  const collect = (typename: string, selections: readonly Selection[], members: Map<string, Member>, refs: Set<string>) => {
    const type = schema.getType(typename)
    const fields = type && isObjectType(type) ? type.getFields() : {}
    for (const selection of selections) {
      if (selection.kind === "scalar") {
        if (selection.fieldName === "__typename") {
          members.set(selection.responseKey, { kind: "scalar", ts: JSON.stringify(typename) })
          continue
        }
        const field = fields[selection.fieldName]
        if (!field) continue
        members.set(selection.responseKey, { kind: "scalar", ts: wrapOutput(field.type, leaf(getNamedType(field.type))) })
      } else if (selection.kind === "link") {
        const field = fields[selection.fieldName]
        if (!field) continue
        const existing = members.get(selection.responseKey)
        if (existing?.kind === "link") existing.selections = [...existing.selections, ...selection.selections]
        else members.set(selection.responseKey, { kind: "link", type: field.type, types: selection.types, selections: [...selection.selections] })
      } else if (selection.kind === "inline") {
        if (selection.possibleTypes === null || selection.possibleTypes.includes(typename))
          collect(typename, selection.selections, members, refs)
      } else if (selection.possibleTypes.includes(typename)) {
        refs.add(selection.name)
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
          const optional = !isNonNullType(field.type)
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
      lines.push(`export type ${typeName} = ${objectType(typenames, fragment.selections)}`)
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
      lines.push(`export type ${typeName} = ${objectType([operation.rootType], operation.selections)}`)
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
    `import type { FragmentArtifact, FragmentRefs, LiveArtifact, OperationArtifact } from ${JSON.stringify(importFrom)}`,
    "",
    ...[...named.values()].filter(Boolean).sort(),
    "",
    ...lines,
    "",
    `/** Live subscriptions per type; pass to createClient({ live: { artifacts: live, ... } }). */`,
    `export const live = ${JSON.stringify(compiled.live)} as unknown as Readonly<Record<string, LiveArtifact>>`,
    `/** Types with @live fragments but no usable Changed subscription; their holders must poll. */`,
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
