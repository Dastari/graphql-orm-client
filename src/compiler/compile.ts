import { createHash } from "node:crypto"
import {
  Kind,
  extendSchema,
  getNamedType,
  isAbstractType,
  isCompositeType,
  isInterfaceType,
  isListType,
  isNonNullType,
  isObjectType,
  parse,
  print,
  specifiedRules,
  validate,
  visit,
  type ArgumentNode,
  type DocumentNode,
  type FieldNode,
  type FragmentDefinitionNode,
  type GraphQLCompositeType,
  type GraphQLOutputType,
  type GraphQLSchema,
  type OperationDefinitionNode,
  type SelectionSetNode,
  type ValueNode,
} from "graphql"
import type {
  ArgumentSpec,
  ConnectionSpec,
  FragmentArtifact,
  LiveArtifact,
  LiveMode,
  OperationArtifact,
  Selection,
} from "../artifact.js"

export interface CompileOptions {
  /**
   * Key fields per type, in primary-key order. `null` marks a type without a key (its records
   * are stored inside their parent). Types not listed use `Id` when they have that field.
   */
  readonly keys?: Readonly<Record<string, readonly string[] | null>>
  /**
   * The record-version field per type (a managed graphql-orm version). A write carrying an older
   * version never replaces a newer stored record.
   */
  readonly versions?: Readonly<Record<string, string>>
  /** The generated subscription field for a type. Default `${typename}Changed`. */
  readonly liveField?: (typename: string) => string
  /** Connection field names, when they differ from graphql-orm's PascalCase defaults. */
  readonly connection?: Partial<Omit<ConnectionSpec, "key">>
}

export interface CompileResult {
  // Runtime-compiled artifacts carry no static types; generated code supplies them.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly operations: Readonly<Record<string, OperationArtifact<any, any>>>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly fragments: Readonly<Record<string, FragmentArtifact<any, string>>>
  /** Live subscriptions per type that has `@live` fragments. */
  readonly live: Readonly<Record<string, LiveArtifact>>
  /** Types with `@live` fragments but no usable `Changed` subscription; they need polling. */
  readonly liveUnavailable: readonly string[]
}

export class CompileError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`GraphQL documents failed to compile:\n${problems.join("\n")}`)
    this.name = "CompileError"
  }
}

const CLIENT_DIRECTIVES = parse(`
  directive @live on FRAGMENT_DEFINITION
  directive @connection(key: String!, paging: [String!]) on FIELD
  directive @refetchable(queryName: String) on FRAGMENT_DEFINITION
`)

const CLIENT_DIRECTIVE_NAMES = new Set(["live", "connection", "refetchable"])

/** graphql-orm's connection and keyset field names. */
const DEFAULT_CONNECTION = {
  paging: ["Page"],
  edges: "Edges",
  node: "Node",
  cursor: "Cursor",
  pageInfo: "PageInfo",
  endCursor: "EndCursor",
  hasNextPage: "HasNextPage",
  after: "after",
} as const

/** Remove client-only directives from what is sent to the server. */
function stripClientDirectives<T extends import("graphql").ASTNode>(node: T): T {
  return visit(node, {
    Directive(directive) {
      return CLIENT_DIRECTIVE_NAMES.has(directive.name.value) ? null : undefined
    },
  }) as T
}

/** Key fields of a type: explicit configuration, else `Id` when the type has it. */
export function keyFieldsOf(
  schema: GraphQLSchema,
  typename: string,
  options: CompileOptions = {}
): readonly string[] | null {
  if (options.keys && typename in options.keys) return options.keys[typename] ?? null
  const type = schema.getType(typename)
  if (type && isObjectType(type) && "Id" in type.getFields()) return ["Id"]
  return null
}

/**
 * Compile GraphQL documents into runtime artifacts. Every document is validated against the
 * schema. `__typename` and key fields are added to each selection on a composite type, so the
 * store can always identify records.
 */
export function compile(
  schema: GraphQLSchema,
  sources: readonly (string | DocumentNode)[],
  options: CompileOptions = {}
): CompileResult {
  return compileDocuments(schema, sources, options, false)
}

/** `nested`: compiling a generated live or refetch operation, which gets no live or refetch artifacts of its own. */
function compileDocuments(
  schema: GraphQLSchema,
  sources: readonly (string | DocumentNode)[],
  options: CompileOptions,
  nested: boolean
): CompileResult {
  const clientSchema = extendSchema(schema, CLIENT_DIRECTIVES)
  const documents = sources.map((source) => (typeof source === "string" ? parse(source) : source))
  const fragmentNodes = new Map<string, FragmentDefinitionNode>()
  const operationNodes: OperationDefinitionNode[] = []
  const problems: string[] = []

  for (const document of documents) {
    for (const definition of document.definitions) {
      if (definition.kind === Kind.FRAGMENT_DEFINITION) {
        if (fragmentNodes.has(definition.name.value))
          problems.push(`Fragment ${definition.name.value} is defined more than once`)
        fragmentNodes.set(definition.name.value, definition)
      } else if (definition.kind === Kind.OPERATION_DEFINITION) {
        if (!definition.name) problems.push("Every operation needs a name")
        else operationNodes.push(definition)
      }
    }
  }
  const operationNames = new Set<string>()
  for (const operation of operationNodes) {
    const name = operation.name!.value
    if (operationNames.has(name)) problems.push(`Operation ${name} is defined more than once`)
    operationNames.add(name)
  }

  // Validate the whole set as one document so cross-file fragment spreads resolve.
  const combined: DocumentNode = {
    kind: Kind.DOCUMENT,
    definitions: [...operationNodes, ...fragmentNodes.values()],
  }
  // Fragments may be compiled without an operation that uses them.
  const rules = specifiedRules.filter((rule) => rule.name !== "NoUnusedFragmentsRule")
  for (const error of validate(clientSchema, combined, rules)) problems.push(error.message)
  if (problems.length) throw new CompileError(problems)

  const augment = (selectionSet: SelectionSetNode, parent: GraphQLCompositeType): SelectionSetNode =>
    augmentSelectionSet(schema, selectionSet, parent, options)

  const fragments: Record<string, FragmentArtifact> = {}
  const augmentedFragments = new Map<string, FragmentDefinitionNode>()
  for (const [name, node] of fragmentNodes) {
    const parent = schema.getType(node.typeCondition.name.value) as GraphQLCompositeType
    const augmented: FragmentDefinitionNode = {
      ...node,
      directives: [],
      selectionSet: augment(node.selectionSet, parent),
    }
    augmentedFragments.set(name, augmented)
    fragments[name] = {
      kind: "fragment",
      name,
      typeCondition: parent.name,
      selections: convert(schema, augmented.selectionSet, parent, fragmentNodes, false, options),
      live: (node.directives ?? []).some((directive) => directive.name.value === "live"),
    }
  }

  const metadata = typeMetadata(schema, options)
  const operations: Record<string, OperationArtifact> = {}
  for (const node of operationNodes) {
    const name = node.name!.value
    const rootType = schema.getRootType(node.operation)
    if (!rootType) throw new CompileError([`The schema has no ${node.operation} root`])
    const augmented: OperationDefinitionNode = {
      ...node,
      selectionSet: augmentSelectionSet(schema, node.selectionSet, rootType, options, false),
    }
    const used = usedFragments(augmented.selectionSet, fragmentNodes)
    const text = [augmented, ...[...used].sort().map((fragment) => augmentedFragments.get(fragment)!)]
      .map((definition) => print(stripClientDirectives(definition)))
      .join("\n\n")
    const reachable = reachableTypes(convert(schema, augmented.selectionSet, rootType, augmentedFragments, true, options))
    operations[name] = {
      kind: node.operation,
      keys: pick(metadata.keys, reachable),
      versions: pick(metadata.versions, reachable),
      name,
      text,
      hash: createHash("sha256").update(text).digest("hex"),
      rootType: rootType.name,
      selections: convert(schema, augmented.selectionSet, rootType, fragmentNodes, false, options),
      normalization: convert(schema, augmented.selectionSet, rootType, augmentedFragments, true, options),
      fragments: Object.fromEntries([...used].sort().map((fragment) => [fragment, fragments[fragment]!])),
    }
  }
  if (nested) return { operations, fragments, live: {}, liveUnavailable: [] }
  const { live, liveUnavailable } = compileLive(schema, fragments, fragmentNodes, options)
  const refetchable = compileRefetch(schema, fragments, fragmentNodes, operationNames, options)
  return { operations, fragments: { ...fragments, ...refetchable }, live, liveUnavailable }
}

/**
 * A fragment marked `@refetchable` gets a query that reads it again through the router's
 * `node(NodeId)` lookup: `query <Fragment>Refetch($NodeId: ID!) { node(NodeId: $NodeId) { ...F } }`.
 * The fragment's type must implement `Node`, and the fragment can't use operation variables.
 */
function compileRefetch(
  schema: GraphQLSchema,
  fragments: Readonly<Record<string, FragmentArtifact>>,
  fragmentNodes: ReadonlyMap<string, FragmentDefinitionNode>,
  operationNames: ReadonlySet<string>,
  options: CompileOptions
): Record<string, FragmentArtifact> {
  const result: Record<string, FragmentArtifact> = {}
  const problems: string[] = []
  const queryNames = new Set<string>()
  for (const [name, node] of fragmentNodes) {
    const directive = (node.directives ?? []).find((entry) => entry.name.value === "refetchable")
    if (!directive) continue
    const nameArg = directive.arguments?.find((arg) => arg.name.value === "queryName")
    const queryName = nameArg?.value.kind === Kind.STRING ? nameArg.value.value : `${name}Refetch`
    const nodeField = schema.getQueryType()?.getFields()["node"]
    const nodeInterface = schema.getType("Node")
    const type = schema.getType(fragments[name]!.typeCondition)
    if (!nodeField || !nodeField.args.some((arg) => arg.name === "NodeId") || !nodeInterface || !isInterfaceType(nodeInterface)) {
      problems.push(`Fragment ${name} is @refetchable, but the schema has no node(NodeId) lookup`)
      continue
    }
    const implementsNode =
      type === nodeInterface ||
      (type && isObjectType(type) && type.getInterfaces().includes(nodeInterface)) ||
      (type && isAbstractType(type) && schema.getPossibleTypes(type).every((entry) => entry.getInterfaces().includes(nodeInterface)))
    if (!implementsNode) {
      problems.push(`Fragment ${name} is @refetchable, but ${type?.name ?? "its type"} does not implement Node`)
      continue
    }
    if (operationNames.has(queryName) || queryNames.has(queryName)) {
      problems.push(`Fragment ${name}'s refetch query ${queryName} has the name of another operation`)
      continue
    }
    queryNames.add(queryName)
    const text = `query ${queryName}($NodeId: ID!) { node(NodeId: $NodeId) { ...${name} } }`
    const document: DocumentNode = {
      kind: Kind.DOCUMENT,
      definitions: [...parse(text).definitions, ...fragmentNodes.values()],
    }
    let compiled: CompileResult
    try {
      compiled = compileDocuments(schema, [document], options, true)
    } catch (error) {
      const detail = error instanceof CompileError ? error.problems.join("; ") : String(error)
      problems.push(`Fragment ${name} can't be @refetchable (a refetchable fragment can't use operation variables): ${detail}`)
      continue
    }
    result[name] = { ...fragments[name]!, refetch: compiled.operations[queryName]! }
  }
  if (problems.length) throw new CompileError(problems)
  return result
}

function compileLive(
  schema: GraphQLSchema,
  fragments: Readonly<Record<string, FragmentArtifact>>,
  fragmentNodes: ReadonlyMap<string, FragmentDefinitionNode>,
  options: CompileOptions
): { live: Record<string, LiveArtifact>; liveUnavailable: string[] } {
  const byType = new Map<string, string[]>()
  for (const fragment of Object.values(fragments)) {
    if (!fragment.live) continue
    const type = schema.getType(fragment.typeCondition)
    if (!type || !isObjectType(type)) continue
    byType.set(type.name, [...(byType.get(type.name) ?? []), fragment.name])
  }
  const live: Record<string, LiveArtifact> = {}
  const liveUnavailable: string[] = []
  const subscriptionRoot = schema.getSubscriptionType()
  for (const [typename, names] of [...byType].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const fieldName = options.liveField?.(typename) ?? `${typename}Changed`
    const field = subscriptionRoot?.getFields()[fieldName]
    const payload = field ? getNamedType(field.type) : undefined
    if (!field || !payload || !isObjectType(payload)) {
      liveUnavailable.push(typename)
      continue
    }
    const payloadFields = Object.values(payload.getFields())
    const entity = payloadFields.find((candidate) => getNamedType(candidate.type).name === typename)
    const action = payloadFields.find((candidate) => candidate.name.toLowerCase() === "action")
    const keyFields = keyFieldsOf(schema, typename, options)
    if (!entity || !action || !keyFields) {
      liveUnavailable.push(typename)
      continue
    }
    const keysArg = field.args.find((arg) => arg.name.toLowerCase() === "keys")
    const keyArg = field.args.find((arg) => arg.name.toLowerCase() === "key")
    const mode: LiveMode = keysArg ? "keys" : keyArg ? "key" : "unkeyed"
    const arg = keysArg ?? keyArg
    const operationName = `Live${typename}`
    const variables = arg ? `($${arg.name}: ${String(arg.type)})` : ""
    const argumentUse = arg ? `(${arg.name}: $${arg.name})` : ""
    const spreads = [...names].sort().map((name) => `...${name}`).join(" ")
    const text = `subscription ${operationName}${variables} { ${fieldName}${argumentUse} { ${action.name} ${entity.name} { ${spreads} } } }`
    const document: DocumentNode = {
      kind: Kind.DOCUMENT,
      definitions: [...parse(text).definitions, ...fragmentNodes.values()],
    }
    const compiled = compileDocuments(schema, [document], options, true)
    live[typename] = {
      typename,
      mode,
      field: fieldName,
      entityField: entity.name,
      actionField: action.name,
      keyArgument: arg?.name ?? null,
      keyFields,
      operation: compiled.operations[operationName]!,
    }
  }
  return { live, liveUnavailable }
}

function pick<T>(source: Record<string, T>, names: ReadonlySet<string>): Record<string, T> {
  return Object.fromEntries(Object.entries(source).filter(([name]) => names.has(name)))
}

function reachableTypes(selections: readonly Selection[], found = new Set<string>()): Set<string> {
  for (const selection of selections) {
    if (selection.kind === "link" || selection.kind === "inline") {
      if (selection.kind === "link") for (const type of selection.types) found.add(type)
      if (selection.kind === "inline") for (const type of selection.possibleTypes ?? []) found.add(type)
      reachableTypes(selection.selections, found)
    }
  }
  return found
}

/** A connection needs each edge's cursor and the page info to continue and merge. */
function ensureConnectionFields(
  selectionSet: SelectionSetNode,
  names: Omit<ConnectionSpec, "key">
): SelectionSetNode {
  const ensure = (set: SelectionSetNode, fieldName: string, children: readonly string[]): SelectionSetNode => {
    const index = set.selections.findIndex(
      (entry) => entry.kind === Kind.FIELD && entry.name.value === fieldName && !entry.alias
    )
    const existing = index >= 0 ? (set.selections[index] as FieldNode) : field(fieldName)
    const inner = existing.selectionSet ?? { kind: Kind.SELECTION_SET, selections: [] }
    const present = new Set(inner.selections.flatMap((entry) => (entry.kind === Kind.FIELD && !entry.alias ? [entry.name.value] : [])))
    const updated: FieldNode = {
      ...existing,
      selectionSet: { ...inner, selections: [...inner.selections, ...children.filter((child) => !present.has(child)).map(field)] },
    }
    const selections = [...set.selections]
    if (index >= 0) selections[index] = updated
    else selections.push(updated)
    return { ...set, selections }
  }
  return ensure(ensure(selectionSet, names.edges, [names.cursor]), names.pageInfo, [names.hasNextPage, names.endCursor])
}

function connectionSpec(node: FieldNode, options: CompileOptions): ConnectionSpec | undefined {
  const directive = (node.directives ?? []).find((entry) => entry.name.value === "connection")
  if (!directive) return undefined
  const keyArg = directive.arguments?.find((arg) => arg.name.value === "key")
  const pagingArg = directive.arguments?.find((arg) => arg.name.value === "paging")
  const key = keyArg?.value.kind === Kind.STRING ? keyArg.value.value : node.name.value
  const paging =
    pagingArg?.value.kind === Kind.LIST
      ? pagingArg.value.values.flatMap((value) => (value.kind === Kind.STRING ? [value.value] : []))
      : undefined
  return { ...DEFAULT_CONNECTION, ...options.connection, key, ...(paging ? { paging } : {}) }
}

function field(name: string): FieldNode {
  return { kind: Kind.FIELD, name: { kind: Kind.NAME, value: name } }
}

function augmentSelectionSet(
  schema: GraphQLSchema,
  selectionSet: SelectionSetNode,
  parent: GraphQLCompositeType,
  options: CompileOptions,
  addIdentity = true
): SelectionSetNode {
  const selections = selectionSet.selections.map((selection) => {
    if (selection.kind === Kind.FIELD) {
      if (!selection.selectionSet) return selection
      const fieldDef = isAbstractType(parent) || isObjectType(parent)
        ? "getFields" in parent
          ? parent.getFields()[selection.name.value]
          : undefined
        : undefined
      const named = fieldDef ? getNamedType(fieldDef.type) : undefined
      if (!named || !isCompositeType(named)) return selection
      const isConnection = (selection.directives ?? []).some((directive) => directive.name.value === "connection")
      const selectionSet = isConnection
        ? ensureConnectionFields(selection.selectionSet, { ...DEFAULT_CONNECTION, ...options.connection })
        : selection.selectionSet
      return { ...selection, selectionSet: augmentSelectionSet(schema, selectionSet, named, options) }
    }
    if (selection.kind === Kind.INLINE_FRAGMENT) {
      const target = selection.typeCondition
        ? (schema.getType(selection.typeCondition.name.value) as GraphQLCompositeType)
        : parent
      return {
        ...selection,
        selectionSet: augmentSelectionSet(schema, selection.selectionSet, target, options, isObjectType(target)),
      }
    }
    return selection
  })
  if (!addIdentity) return { ...selectionSet, selections }
  const present = new Set(
    selections.flatMap((selection) =>
      selection.kind === Kind.FIELD && !selection.alias ? [selection.name.value] : []
    )
  )
  const additions: FieldNode[] = []
  if (!present.has("__typename")) additions.push(field("__typename"))
  if (isObjectType(parent)) {
    for (const key of keyFieldsOf(schema, parent.name, options) ?? []) {
      if (!present.has(key)) additions.push(field(key))
    }
  }
  return { ...selectionSet, selections: [...additions, ...selections] }
}

function usedFragments(
  selectionSet: SelectionSetNode,
  fragments: ReadonlyMap<string, FragmentDefinitionNode>,
  found = new Set<string>()
): Set<string> {
  visit(selectionSet, {
    FragmentSpread(node) {
      const name = node.name.value
      if (found.has(name)) return
      found.add(name)
      const definition = fragments.get(name)
      if (definition) usedFragments(definition.selectionSet, fragments, found)
    },
  })
  return found
}

function possibleTypes(schema: GraphQLSchema, type: GraphQLCompositeType): string[] {
  return isAbstractType(type) ? schema.getPossibleTypes(type).map((entry) => entry.name).sort() : [type.name]
}

/** Key and version fields of every object type the selections can reach. */
function typeMetadata(
  schema: GraphQLSchema,
  options: CompileOptions
): { keys: Record<string, readonly string[]>; versions: Record<string, string> } {
  const keys: Record<string, readonly string[]> = {}
  const versions: Record<string, string> = {}
  for (const type of Object.values(schema.getTypeMap())) {
    if (!isObjectType(type) || type.name.startsWith("__")) continue
    const fields = keyFieldsOf(schema, type.name, options)
    if (fields) keys[type.name] = fields
    const version = options.versions?.[type.name]
    if (version) versions[type.name] = version
  }
  return { keys, versions }
}

function isPlural(type: GraphQLOutputType): boolean {
  const inner = isNonNullType(type) ? type.ofType : type
  return isListType(inner)
}

function argumentSpec(name: string, value: ValueNode): ArgumentSpec {
  switch (value.kind) {
    case Kind.VARIABLE:
      return { kind: "variable", name, variable: value.name.value }
    case Kind.OBJECT:
      return {
        kind: "object",
        name,
        fields: value.fields.map((entry) => argumentSpec(entry.name.value, entry.value)),
      }
    case Kind.LIST:
      return { kind: "list", name, items: value.values.map((item, index) => argumentSpec(String(index), item)) }
    case Kind.NULL:
      return { kind: "literal", name, value: null }
    case Kind.INT:
      return { kind: "literal", name, value: Number.parseInt(value.value, 10) }
    case Kind.FLOAT:
      return { kind: "literal", name, value: Number.parseFloat(value.value) }
    case Kind.BOOLEAN:
      return { kind: "literal", name, value: value.value }
    default:
      return { kind: "literal", name, value: value.value }
  }
}

function argumentsOf(nodes: readonly ArgumentNode[] | undefined): ArgumentSpec[] {
  return (nodes ?? []).map((node) => argumentSpec(node.name.value, node.value))
}

function convert(
  schema: GraphQLSchema,
  selectionSet: SelectionSetNode,
  parent: GraphQLCompositeType,
  fragments: ReadonlyMap<string, FragmentDefinitionNode>,
  inlineSpreads: boolean,
  options: CompileOptions = {}
): Selection[] {
  const result: Selection[] = []
  for (const selection of selectionSet.selections) {
    if (selection.kind === Kind.FIELD) {
      const name = selection.name.value
      const responseKey = selection.alias?.value ?? name
      const args = argumentsOf(selection.arguments)
      if (name === "__typename" || !selection.selectionSet) {
        result.push({ kind: "scalar", responseKey, fieldName: name, args })
        continue
      }
      const fieldDef = "getFields" in parent ? parent.getFields()[name] : undefined
      if (!fieldDef) throw new CompileError([`${parent.name}.${name} does not exist`])
      const named = getNamedType(fieldDef.type) as GraphQLCompositeType
      result.push({
        kind: "link",
        responseKey,
        fieldName: name,
        args,
        plural: isPlural(fieldDef.type),
        types: possibleTypes(schema, named),
        selections: convert(schema, selection.selectionSet, named, fragments, inlineSpreads, options),
        ...(connectionSpec(selection, options) ? { connection: connectionSpec(selection, options)! } : {}),
      })
    } else if (selection.kind === Kind.INLINE_FRAGMENT) {
      const typeCondition = selection.typeCondition?.name.value ?? null
      const target = typeCondition ? (schema.getType(typeCondition) as GraphQLCompositeType) : parent
      result.push({
        kind: "inline",
        typeCondition,
        possibleTypes: typeCondition ? possibleTypes(schema, target) : null,
        selections: convert(schema, selection.selectionSet, target, fragments, inlineSpreads, options),
      })
    } else {
      const definition = fragments.get(selection.name.value)!
      const typeCondition = definition.typeCondition.name.value
      if (inlineSpreads) {
        const target = schema.getType(typeCondition) as GraphQLCompositeType
        result.push({
          kind: "inline",
          typeCondition,
          possibleTypes: possibleTypes(schema, target),
          selections: convert(schema, definition.selectionSet, target, fragments, true, options),
        })
      } else {
        const target = schema.getType(typeCondition) as GraphQLCompositeType
        result.push({
          kind: "spread",
          name: selection.name.value,
          typeCondition,
          possibleTypes: possibleTypes(schema, target),
        })
      }
    }
  }
  return result
}
