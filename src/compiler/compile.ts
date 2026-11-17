import { createHash } from "node:crypto"
import {
  Kind,
  extendSchema,
  getNamedType,
  isAbstractType,
  isCompositeType,
  isInterfaceType,
  isListType,
  isInputObjectType,
  isNonNullType,
  isObjectType,
  isScalarType,
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
  type GraphQLObjectType,
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
  PagedSpec,
  Selection,
} from "../artifact.js"
import { printStable } from "./print.js"

/** Severity of a project policy diagnostic. */
export type StrictLevel = "error" | "warn" | "off"

export interface CompileOptions {
  /** Live fragments remain explicit by default. Default mode is opt-in, optionally by source path. */
  readonly live?: "explicit" | "default" | { readonly default: readonly string[] }
  /** Policy severities; each rule defaults to error. */
  readonly strict?: Partial<Record<"liveWithoutStream" | "pollWithoutReason" | "rawSubscriptions" | "queryOwnership", StrictLevel>> & {
    /**
     * A fragment on a keyed type with a `Changed` stream that isn't live, and so won't update on screen. Default `warn`: it's easy to miss, and
     * nothing says so at run time. `@live(enabled: false)` on a fragment says it's meant.
     */
    readonly fragmentNotLive?: StrictLevel
  }
  /** Query document owners, relative to the config directory; absent disables ownership checks. */
  readonly queryOwners?: readonly string[]
  /** Paths allowed to declare raw subscriptions; absent disables this check. */
  readonly subscriptionPaths?: readonly string[]
  /** Source text to all declaring files, relative to the config directory. CLI supplies this. */
  readonly documentPaths?: Readonly<Record<string, readonly string[]>>
  /** Reject unsupported conditional selections. legacy preserves the previous unsafe behaviour for migration only. */
  readonly conditionalDirectives?: "reject" | "legacy"

  /** Stream projection; as-written preserves legacy fragment spreading. */
  readonly liveSelection?: "full" | "as-written"
  /** Reports fields omitted from generated stream projections. */
  readonly onWarning?: (message: string) => void
  /**
   * Key fields per type, in primary-key order. `null` marks a type without a key (its records
   * are stored inside their parent). Types not listed use `<Type>KeyInput` field order, else `Id` when present.
   */
  readonly keys?: Readonly<Record<string, readonly string[] | null>>
  /** Explicit expiry field and representation; no fields are inferred by name. */
  readonly lifetimes?: Readonly<Record<string, import("../store/lifetime.js").LifetimePolicy>>
  /**
   * The record-version field per type. A write carrying an older version never replaces a newer
   * stored record. Types not listed use graphql-orm's `RecordVersion` when they have it, and the
   * compiler selects it; `null` turns that off for a type, and the last write to arrive wins.
   *
   * A field named on its own must be `Int` or `Float`; anything else fails generation, naming the
   * type and field. `{ field, compare }` declares how its values compare: `"number"` for a custom
   * scalar sent as a JSON number, `"decimal"` for a decimal integer sent as a string, compared
   * exactly as a big integer, past 2^53 too. Under `"decimal"` a JSON number is compared only up to
   * 2^53. A value that can't be compared that way (absent, not a decimal integer, or a number past
   * 2^53) is written: the last write to arrive wins.
   */
  readonly versions?: Readonly<Record<string, string | VersionPolicy | null>>
  /**
   * Whether the key, `NodeId` and version fields the compiler adds to a selection are read into query and fragment data.
   * Default `"selected"`: they're sent and stored, but data holds them only where the document selects them itself, so a
   * version that advances behind a fragment doesn't change the data of the query that spreads it. `"always"` reads them
   * everywhere, as 0.1.0-alpha.12 and earlier did. Either way the operation text and what's stored are the same.
   */
  readonly identityFields?: "selected" | "always"
  /** The generated subscription field for a type. Default `${typename}Changed`. */
  readonly liveField?: (typename: string) => string
  /** Connection field names, when they differ from graphql-orm's PascalCase defaults. */
  readonly connection?: Partial<Omit<ConnectionSpec, "key">>
  /** `@paged` field names, when they differ from graphql-orm's `PageInput` and `PageInfo`. */
  readonly paged?: Partial<Omit<PagedSpec, "path" | "variable">>
}

/** A version field with a declared comparison (see `CompileOptions.versions`). */
export interface VersionPolicy {
  readonly field: string
  readonly compare: "number" | "decimal"
}

export interface CompileResult {
  // Runtime-compiled artifacts carry no static types; generated code supplies them.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly operations: Readonly<Record<string, OperationArtifact<any, any>>>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly fragments: Readonly<Record<string, FragmentArtifact<any, string>>>
  /** Live subscriptions per type with live fragments (explicit or enabled by the live setting). */
  readonly live: Readonly<Record<string, LiveArtifact>>
  /** Types with live fragments but no usable `Changed` subscription; they need polling. */
  readonly liveUnavailable: readonly string[]
  /** What each `live: { default: [...] }` pattern covered, in pattern order. Absent under any other live setting. */
  readonly liveAreas?: readonly LiveAreaReport[]
}

/**
 * The fragments one `live.default` pattern covers: those written in a file the pattern matches.
 * Every fragment it covers is in exactly one of the outcome lists. Names are sorted.
 */
export interface LiveAreaReport {
  readonly pattern: string
  /** Matched files that define at least one fragment, relative to the config directory. */
  readonly files: readonly string[]
  readonly fragments: readonly string[]
  /** Made live by the pattern, with a usable `Changed` stream. */
  readonly newlyLive: readonly string[]
  /** Marked `@live` already, so the pattern changed nothing. */
  readonly alreadyLive: readonly string[]
  /** Marked `@live(enabled: false)`. */
  readonly optedOut: readonly string[]
  /** On an object type without a key (configured `null`, or none found), so not live. */
  readonly keyless: readonly string[]
  /** Made live by the pattern, but the type has no usable `Changed` stream: its holders poll. */
  readonly withoutStream: readonly string[]
  /** On an interface or union, which needs an explicit `@live`. */
  readonly abstract: readonly string[]
}

export class CompileError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`GraphQL documents failed to compile:\n${problems.join("\n")}`)
    this.name = "CompileError"
  }
}

const CLIENT_DIRECTIVES = parse(`
  directive @batch(foreignKey: String!, root: String!, key: String!, limit: Int = 100) on FIELD
  directive @live(enabled: Boolean = true) on FRAGMENT_DEFINITION
  directive @poll(reason: String!) on QUERY | FRAGMENT_DEFINITION
  directive @sensitive on QUERY | MUTATION
  directive @connection(key: String!, paging: [String!]) on FIELD
  directive @refetchable(queryName: String) on FRAGMENT_DEFINITION
  directive @paged(paging: String) on FIELD
`)

// Each live type compiles nested documents, so without this a large schema is extended hundreds of times.
const clientSchemas = new WeakMap<GraphQLSchema, GraphQLSchema>()

function clientSchemaOf(schema: GraphQLSchema): GraphQLSchema {
  let extended = clientSchemas.get(schema)
  if (!extended) {
    extended = extendSchema(schema, CLIENT_DIRECTIVES)
    clientSchemas.set(schema, extended)
  }
  return extended
}

const CLIENT_DIRECTIVE_NAMES = new Set(["live", "poll", "connection", "refetchable", "paged", "sensitive", "batch"])

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

/** graphql-orm's offset `PageInput` and `PageInfo` field names, for `@paged`. */
const DEFAULT_PAGED = {
  limit: "Limit",
  offset: "Offset",
  totalCount: "TotalCount",
  hasPreviousPage: "HasPreviousPage",
} as const

type PagedNames = { readonly [K in keyof Omit<PagedSpec, "path" | "variable">]: string }

function pagedNames(options: CompileOptions): PagedNames {
  const connection = { ...DEFAULT_CONNECTION, ...options.connection }
  return {
    edges: connection.edges,
    pageInfo: connection.pageInfo,
    hasNextPage: connection.hasNextPage,
    ...DEFAULT_PAGED,
    ...options.paged,
    hasPreviousPage: options.paged?.hasPreviousPage ?? DEFAULT_PAGED.hasPreviousPage,
  }
}

/** Remove client-only directives from what is sent to the server. */
function stripClientDirectives<T extends import("graphql").ASTNode>(node: T): T {
  return visit(node, {
    Field(node) {
      if (node.directives?.some(d => d.name.value === "batch")) return null
    },
    Directive(directive) {
      return CLIENT_DIRECTIVE_NAMES.has(directive.name.value) ? null : undefined
    },
  }) as T
}

/**
 * `streamProjection`: a generated stream's selection, which carries no `NodeId` or added version.
 * `readSelection`: the selection data is read through, which leaves out the identity fields the document didn't select.
 */
type ProjectionOptions = CompileOptions & { readonly streamProjection?: boolean; readonly readSelection?: boolean }

const NODE_ID = "NodeId"

/**
 * Whether a type carries graphql-orm's generated `NodeId: ID!`. The server's NodeId identifies the
 * record for any key shape, so the compiler selects it and the store prefers it to key fields.
 */
function hasNodeId(type: GraphQLCompositeType): boolean {
  if (!isObjectType(type) && !isInterfaceType(type)) return false
  const nodeId = type.getFields()[NODE_ID]
  return nodeId !== undefined && getNamedType(nodeId.type).name === "ID"
}

const RECORD_VERSION = "RecordVersion"

/**
 * The record-version field of a type: explicit configuration, else graphql-orm's generated
 * `RecordVersion: Int!` for a managed version.
 */
function versionFieldOf(type: GraphQLObjectType, options: CompileOptions): string | null {
  return versionPolicyOf(type, options)?.field ?? null
}

function versionPolicyOf(type: GraphQLObjectType, options: CompileOptions): VersionPolicy | null {
  const configured = options.versions?.[type.name]
  if (configured === null) return null
  if (typeof configured === "string") return { field: configured, compare: "number" }
  if (configured !== undefined) return configured
  const recordVersion = type.getFields()[RECORD_VERSION]
  return recordVersion !== undefined && getNamedType(recordVersion.type).name === "Int" ? { field: RECORD_VERSION, compare: "number" } : null
}

/**
 * Why a configured version field can't order a type's records, or null when it can. The store compares versions as
 * numbers unless told otherwise, so a string version would never be compared and the last write would win unseen.
 */
function versionProblem(type: GraphQLObjectType, configured: string | VersionPolicy): string | null {
  const at = `versions.${type.name}`
  const field = typeof configured === "string" ? configured : configured.field
  if (typeof field !== "string" || !field) return `${at}: give a field name, { "field": "<name>", "compare": "number" | "decimal" }, or null`
  const compare = typeof configured === "string" ? undefined : configured.compare
  if (compare !== undefined && compare !== "number" && compare !== "decimal") return `${at}: compare must be "number" or "decimal"`
  const definition = type.getFields()[field]
  if (!definition) return `${at}: ${type.name}.${field} does not exist`
  const named = getNamedType(definition.type)
  const shown = `${type.name}.${field} is ${String(definition.type)}`
  const fix = `Declare how it compares, as { "field": "${field}", "compare": "decimal" } for a decimal integer, or set it to null for last-write-wins.`
  const list = isListType(isNonNullType(definition.type) ? definition.type.ofType : definition.type)
  if (list || definition.args.length || !isScalarType(named) || named.name === "Boolean")
    return `${at}: ${shown}, which can't order records. Name a number or decimal integer field, or set it to null for last-write-wins.`
  if (compare === undefined && named.name !== "Int" && named.name !== "Float")
    return `${at}: ${shown}, not Int or Float, so its values would never be compared and the last write would win. ${fix}`
  if (compare === "number" && (named.name === "String" || named.name === "ID"))
    return `${at}: ${shown}, which is sent as a string, not a number. ${fix}`
  return null
}

/** Key fields of a type: explicit configuration, else `Id` when the type has it. */
export function keyFieldsOf(
  schema: GraphQLSchema,
  typename: string,
  options: CompileOptions = {}
): readonly string[] | null {
  if (options.keys && typename in options.keys) return options.keys[typename] ?? null
  const type = schema.getType(typename)
  const input = schema.getType(`${typename}KeyInput`)
  if (input && isInputObjectType(input) && type && isObjectType(type)) {
    // An unrelated input can share the name, as `ApiKeyInput` for a type `Api`: its fields must be the type's.
    const fields = Object.keys(input.getFields())
    if (fields.length && fields.every((field) => field in type.getFields())) return fields
  }
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
  const clientSchema = clientSchemaOf(schema)
  const documents = sources.map((source) => (typeof source === "string" ? parse(source) : source))
  const paths = new Map<FragmentDefinitionNode | OperationDefinitionNode, readonly string[]>()
  documents.forEach((document, index) => {
    const source = sources[index]!
    const text = typeof source === "string" ? source : source.loc?.source.body ?? print(source)
    const sourceName = document.loc?.source.name
    const files = options.documentPaths?.[text] ?? [sourceName && sourceName !== "GraphQL request" ? sourceName : `<document ${index + 1}>`]
    for (const node of document.definitions) {
      if (node.kind === Kind.FRAGMENT_DEFINITION || node.kind === Kind.OPERATION_DEFINITION) paths.set(node, files)
    }
  })
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
  visit(combined, {
    Directive(node) {
      const name = node.name.value
      if ((name === "skip" || name === "include") && options.conditionalDirectives !== "legacy")
        problems.push(`@${name} is unsupported: conditional reads, generated optional types and live projections are not implemented. Split the route query; conditionalDirectives: "legacy" temporarily restores unsafe previous compilation.`)
      if (name === "argumentDefinitions" || name === "arguments")
        problems.push(`@${name}: fragment arguments are unsupported; declare variables on the route operation instead`)
    },
  })
  // Fragments may be compiled without an operation that uses them.
  const rules = specifiedRules.filter((rule) => rule.name !== "NoUnusedFragmentsRule")
  for (const error of validate(clientSchema, combined, rules)) problems.push(error.message)
  for (const [name, node] of fragmentNodes) {
    if (hasDirective(node.selectionSet, "paged"))
      problems.push(`Fragment ${name} uses @paged; mark the list field in the operation that shows the pages`)
  }
  if (problems.length) throw new CompileError(problems)

  const policyProblems: string[] = []
  const report = (rule: keyof NonNullable<CompileOptions["strict"]>, node: FragmentDefinitionNode | OperationDefinitionNode, message: string) => {
    const level = options.strict?.[rule] ?? "error"
    const detail = `${node.kind === Kind.FRAGMENT_DEFINITION ? "Fragment" : "Operation"} ${node.name?.value ?? "<anonymous>"} (${paths.get(node)?.join(", ")}): ${message} [strict.${rule}]`
    if (level === "error") policyProblems.push(detail)
    if (level === "warn") (options.onWarning ?? console.warn)(detail)
  }
  if (!nested) for (const node of [...fragmentNodes.values(), ...operationNodes]) {
    const poll = node.directives?.find((d) => d.name.value === "poll")
    if (poll && !pollReason(node)) report("pollWithoutReason", node, '@poll needs a non-empty reason; use @poll(reason: "why polling is needed")')
    if (node.kind === Kind.OPERATION_DEFINITION) {
      const allowed = node.operation === "query" ? options.queryOwners : node.operation === "subscription" ? options.subscriptionPaths : undefined
      if (allowed && paths.get(node)?.some((file) => file.startsWith("<document ") || !allowed.some((glob) => matchesPath(file, glob)))) {
        report(node.operation === "query" ? "queryOwnership" : "rawSubscriptions", node,
          node.operation === "query" ? "query is outside queryOwners; add its file path to queryOwners" : "raw subscription is outside subscriptionPaths; add its path, or use createStream from graphql-orm-client/streams")
      }
    }
  }

  if (options.identityFields !== undefined && options.identityFields !== "selected" && options.identityFields !== "always")
    throw new CompileError([`identityFields must be "selected" or "always"`])
  // What's sent and stored has every identity field added; what data is read through has only those the document selects.
  const readOptions: ProjectionOptions = options.identityFields === "always" ? options : { ...options, readSelection: true }
  const augment = (selectionSet: SelectionSetNode, parent: GraphQLCompositeType): SelectionSetNode =>
    augmentSelectionSet(schema, selectionSet, parent, options)

  const fragments: Record<string, FragmentArtifact> = {}
  const augmentedFragments = new Map<string, FragmentDefinitionNode>()
  const readFragments = new Map<string, FragmentDefinitionNode>()
  for (const [name, node] of fragmentNodes) {
    const parent = schema.getType(node.typeCondition.name.value) as GraphQLCompositeType
    const augmented: FragmentDefinitionNode = {
      ...node,
      directives: [],
      selectionSet: augment(node.selectionSet, parent),
    }
    augmentedFragments.set(name, augmented)
    const read: FragmentDefinitionNode = readOptions === options ? augmented : { ...augmented, selectionSet: augmentSelectionSet(schema, node.selectionSet, parent, readOptions) }
    readFragments.set(name, read)
    fragments[name] = {
      kind: "fragment",
      ...(pollReason(node) ? { pollReason: pollReason(node) } : {}),
      name,
      typeCondition: parent.name,
      selections: convert(schema, read.selectionSet, parent, fragmentNodes, false, options),
      live: (() => {
        const directive = node.directives?.find((d) => d.name.value === "live")
        const enabled = directive?.arguments?.find((a) => a.name.value === "enabled")?.value
        if (enabled?.kind === Kind.BOOLEAN && !enabled.value) return false
        if (directive) return true
        // A keyless value type has no identity and no stream, and its data comes with its parent.
        if (!isObjectType(parent) || !keyFieldsOf(schema, parent.name, options)) return false
        const setting = options.live
        return setting === "default" || typeof setting === "object" &&
          (paths.get(node) ?? []).some((file) => !file.startsWith("<document ") && setting.default.some((glob) => matchesPath(file, glob)))
      })(),
    }
  }

  const metadata = typeMetadata(schema, options)
  // Not an error, so a project whose schema dropped a type keeps building; but an entry that does nothing shouldn't look like one that does.
  if (!nested) for (const name of Object.keys(options.versions ?? {})) {
    const type = schema.getType(name)
    if (!type || !isObjectType(type))
      (options.onWarning ?? console.warn)(`versions.${name}: the schema has no object type ${name}, so this entry orders nothing. Check the name, or remove the entry.`)
  }
  const operations: Record<string, OperationArtifact> = {}
  for (const node of operationNodes) {
    const name = node.name!.value
    const rootType = schema.getRootType(node.operation)
    if (!rootType) throw new CompileError([`The schema has no ${node.operation} root`])
    const augmented: OperationDefinitionNode = {
      ...node,
      selectionSet: augmentSelectionSet(schema, node.selectionSet, rootType, options, false),
    }
    const readSelectionSet = readOptions === options ? augmented.selectionSet : augmentSelectionSet(schema, node.selectionSet, rootType, readOptions, false)
    const used = usedFragments(augmented.selectionSet, fragmentNodes)
    const sensitive = node.directives?.some(d => d.name.value === "sensitive") === true
    if (sensitive && (hasDirective(node.selectionSet, "batch") || [...used].some(name => hasDirective(fragmentNodes.get(name)!.selectionSet, "batch"))))
      throw new CompileError([`${name}: @sensitive cannot use @batch relations`])
    if (sensitive && [...used].some(name => fragments[name]?.live))
      throw new CompileError([`${name}: @sensitive cannot spread a live fragment; mark it @live(enabled: false) or use a fragment of its own`])
    const wireOperation = stripClientDirectives(augmented)
    const wireFragments = new Map([...augmentedFragments].map(([name, node]) => [name, stripClientDirectives(node)]))
    const wireUsed = usedFragments(wireOperation.selectionSet, wireFragments)
    const text = [wireOperation, ...[...wireUsed].sort().map(fragment => wireFragments.get(fragment)!)]
      .map(definition => printStable(definition)).join("\n\n")
    const normalization = convert(schema, augmented.selectionSet, rootType, augmentedFragments, true, options)
    const reachable = reachableTypes(normalization)
    const paged = pagedSpecOf(schema, node, rootType, options)
    operations[name] = {
      kind: node.operation,
      ...(pollReason(node) ? { pollReason: pollReason(node) } : {}),
      lists: listTypes(schema, normalization, rootType, options),
      ...(sensitive ? { sensitive: true } : {}),
      keys: pick(metadata.keys, reachable),
      versions: pick(metadata.versions, reachable),
      ...(Object.keys(pick(metadata.versionCompare, reachable)).length ? { versionCompare: pick(metadata.versionCompare, reachable) } : {}),
      ...(options.lifetimes ? { lifetimes: pick(options.lifetimes, reachable) } : {}),
      name,
      text,
      hash: createHash("sha256").update(text).digest("hex"),
      rootType: rootType.name,
      selections: convert(schema, readSelectionSet, rootType, sensitive ? readFragments : fragmentNodes, sensitive, options),
      normalization,
      fragments: Object.fromEntries([...used].sort().map((fragment) => [fragment, fragments[fragment]!])),
      ...(paged ? { paged } : {}),
    }
  }
  if (nested) return { operations, fragments, live: {}, liveUnavailable: [] }
  // Lists stay current for types the project made live. Live by default (R1) widens this; a list alone doesn't open a stream.
  const liveTypes = new Set(Object.values(fragments).filter((fragment) => fragment.live).map((fragment) => fragment.typeCondition))
  for (const [name, operation] of Object.entries(operations)) {
    operations[name] = { ...operation, lists: (operation.lists ?? []).filter((typename) => liveTypes.has(typename)) }
  }
  const { live, liveUnavailable } = compileLive(schema, fragments, fragmentNodes, options)
  // A type with a usable stream and no key can't be live. Its fragments are named for that cause, not for a missing stream.
  const keyless = (typename: string): boolean => {
    const type = schema.getType(typename)
    return !!type && isObjectType(type) && !keyFieldsOf(schema, typename, options) && !!changedStreamOf(schema, typename, options)
  }
  for (const [name, node] of fragmentNodes) {
    const typename = fragments[name]!.typeCondition
    if (fragments[name]?.live && node.directives?.some((d) => d.name.value === "live") && liveUnavailable.includes(typename) && !pollReason(node)) {
      const { cause, fix } = keylessCause(typename, options)
      report("liveWithoutStream", node, keyless(typename)
        ? `${typename} has a Changed stream, but ${cause}, so it can't be live. ${fix}, use @live(enabled: false), or add @poll(reason: "why polling is needed")`
        : `${typename} has no usable Changed stream; use @live(enabled: false) or add @poll(reason: "why polling is needed")`)
    }
  }
  if (!nested) {
    // Under any live setting, an unmarked fragment on a keyless type with a stream stays as it is and won't update on screen.
    const byType = new Map<string, string[]>()
    for (const [name, node] of fragmentNodes) {
      const typename = fragments[name]!.typeCondition
      if (!fragments[name]!.live && !node.directives?.some((directive) => directive.name.value === "live") && keyless(typename))
        byType.set(typename, [...(byType.get(typename) ?? []), name])
    }
    const level = options.strict?.fragmentNotLive ?? "warn"
    if (level !== "off") for (const [typename, names] of [...byType].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const { cause, fix } = keylessCause(typename, options)
      const one = names.length === 1
      const message = `${typename} has a Changed stream, but ${cause}, so it can't be live and ${one ? "fragment" : "fragments"} ${names.sort().join(", ")} won't update on screen. ${fix}, or mark ${one ? "it" : "them"} @live(enabled: false) if that's meant. [strict.fragmentNotLive]`
      if (level === "error") policyProblems.push(message)
      else (options.onWarning ?? console.warn)(message)
    }
  }
  if (!nested) {
    const notLive = [...fragmentNodes].filter(([name, node]) => {
      const fragment = fragments[name]
      if (!fragment || fragment.live || node.directives?.some((directive) => directive.name.value === "live")) return false
      const type = schema.getType(fragment.typeCondition)
      if (!type || !isObjectType(type) || !keyFieldsOf(schema, type.name, options)) return false
      return !!schema.getSubscriptionType()?.getFields()[options.liveField?.(type.name) ?? `${type.name}Changed`]
    }).map(([name]) => name)
    const level = options.strict?.fragmentNotLive ?? "warn"
    if (notLive.length && level !== "off") {
      const message = `${notLive.length === 1 ? "Fragment" : "Fragments"} ${notLive.sort().join(", ")} won't update on screen: the type has a Changed stream, but the fragment isn't live. Mark it @live, or @live(enabled: false) if that's meant. [strict.fragmentNotLive]`
      if (level === "error") policyProblems.push(message)
      else (options.onWarning ?? console.warn)(message)
    }
  }
  // An area that matches nothing makes nothing live and says nothing, which is easy to take for a trial that's running.
  let liveAreas: LiveAreaReport[] | undefined
  if (!nested && typeof options.live === "object") {
    const fragmentFiles = [...fragmentNodes.values()].flatMap((node) => paths.get(node) ?? []).filter((file) => !file.startsWith("<document "))
    for (const glob of options.live.default) if (!fragmentFiles.some((file) => matchesPath(file, glob)))
      (options.onWarning ?? console.warn)(`live.default pattern "${glob}" matches no file that defines a fragment, so it makes nothing live. A pattern matches the file a fragment is written in, not the files that spread it.${fragmentFiles.length ? "" : " No fragment here has a source path to match."}`)
    // What each pattern did, so a trial reports itself instead of needing a diff of the generated module.
    const outcome = (name: string, node: FragmentDefinitionNode): Exclude<keyof LiveAreaReport, "pattern" | "files" | "fragments"> => {
      const directive = node.directives?.find((d) => d.name.value === "live")
      const enabled = directive?.arguments?.find((a) => a.name.value === "enabled")?.value
      if (enabled?.kind === Kind.BOOLEAN && !enabled.value) return "optedOut"
      if (directive) return "alreadyLive"
      const typename = fragments[name]!.typeCondition
      const type = schema.getType(typename)
      if (!type || !isObjectType(type)) return "abstract"
      if (!keyFieldsOf(schema, typename, options)) return "keyless"
      return liveUnavailable.includes(typename) ? "withoutStream" : "newlyLive"
    }
    liveAreas = options.live.default.map((pattern) => {
      const report = { pattern, files: [] as string[], fragments: [] as string[], newlyLive: [] as string[], alreadyLive: [] as string[], optedOut: [] as string[], keyless: [] as string[], withoutStream: [] as string[], abstract: [] as string[] }
      for (const [name, node] of fragmentNodes) {
        const files = (paths.get(node) ?? []).filter((file) => !file.startsWith("<document ") && matchesPath(file, pattern))
        if (!files.length) continue
        report.files.push(...files)
        report.fragments.push(name)
        report[outcome(name, node)].push(name)
      }
      for (const list of Object.values(report)) if (Array.isArray(list)) list.sort()
      return { ...report, files: [...new Set(report.files)] }
    })
  }
  if (!nested) for (const typename of liveUnavailable) {
    const implicit = [...fragmentNodes].filter(([name, node]) => fragments[name]?.live && fragments[name]?.typeCondition === typename && !node.directives?.some((d) => d.name.value === "live"))
    for (const [name, node] of implicit) (options.onWarning ?? console.warn)(`Fragment ${name} (${paths.get(node)?.join(", ")}): ${typename} has no usable Changed stream; automatic live fallback polls and health reports no-stream. Use @live(enabled: false) to opt out.`)
  }
  if (policyProblems.length) throw new CompileError(policyProblems)
  if (options.liveSelection !== "as-written") {
    const scalars = (selections: readonly Selection[]): string[] => selections.flatMap((selection) =>
      selection.kind === "scalar" ? [selection.fieldName] : selection.kind === "inline" ? scalars(selection.selections) : [])
    const entitySelection = (selections: readonly Selection[], typename: string): readonly Selection[] => {
      for (const selection of selections) {
        if (selection.kind === "link") {
          if (selection.types.includes(typename)) return selection.selections
          const nested = entitySelection(selection.selections, typename)
          if (nested.length) return nested
        }
      }
      return []
    }
    const carries = new Map(Object.values(live).map((artifact) => [artifact.typename, new Set(scalars(entitySelection(artifact.operation.normalization, artifact.typename)))]))
    for (const [name, operation] of Object.entries(operations)) {
      const stale = new Set<string>()
      const compare = (selections: readonly Selection[], typename: string) => {
        const carried = carries.get(typename)
        for (const selection of selections) {
          if (selection.kind === "inline") compare(selection.selections, typename)
          if (selection.kind === "scalar" && carried && selection.fieldName !== NODE_ID &&
            (selection.args.length || !carried.has(selection.fieldName))) stale.add(typename)
          if (selection.kind === "link") {
            if (carried && !selection.batch) stale.add(typename)
            for (const type of selection.types) compare(selection.selections, type)
          }
        }
      }
      compare(operation.normalization, operation.rootType)
      operations[name] = { ...operation, liveReread: [...stale].sort() }
    }
  }
  shareBatches(schema, operations, fragments, options)
  const refetchable = compileRefetch(schema, fragments, fragmentNodes, operationNames, options)
  return { operations, fragments: { ...fragments, ...refetchable }, live, liveUnavailable, ...(liveAreas ? { liveAreas } : {}) }
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
  if (options.liveSelection === "as-written" && options.onWarning) {
    compileLive(schema, fragments, fragmentNodes, { ...options, liveSelection: "full" })
  }
  const byType = new Map<string, string[]>()
  const liveUnavailable: string[] = []
  for (const fragment of Object.values(fragments)) {
    if (!fragment.live) continue
    const type = schema.getType(fragment.typeCondition)
    if (!type || !isObjectType(type)) {
      if (!liveUnavailable.includes(fragment.typeCondition)) liveUnavailable.push(fragment.typeCondition)
      continue
    }
    byType.set(type.name, [...(byType.get(type.name) ?? []), fragment.name])
  }
  const live: Record<string, LiveArtifact> = {}
  for (const [typename, names] of [...byType].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const stream = changedStreamOf(schema, typename, options)
    const keyFields = keyFieldsOf(schema, typename, options)
    if (!stream || !keyFields) {
      liveUnavailable.push(typename)
      continue
    }
    const { fieldName, entity, action, changeKind, arg, mode } = stream
    if (options.liveSelection === "as-written") {
      const problems = names.flatMap((name) => variableUses(schema, fragmentNodes, name).map(({ site, verb, fragment, variable }) =>
        `Fragment ${name} is live, but ${site}${fragment === name ? "" : ` (in fragment ${fragment})`} ${verb} the operation variable $${variable}. ` +
        `With liveSelection: "as-written" the ${typename} stream spreads ${name}, and one stream is shared by every query that holds a ${typename}, so it can't carry one query's variables. ` +
        `Pass a literal value, move the selection to a fragment that isn't live, mark ${name} @live(enabled: false), or remove liveSelection: "as-written": ` +
        `the default stream projection leaves the field out and the queries holding the record read it again with their own variables.`))
      if (problems.length) throw new CompileError(problems)
    }
    const operationName = `Live${typename}`
    const variables = arg ? `($${arg.name}: ${String(arg.type)})` : ""
    const argumentUse = arg ? `(${arg.name}: $${arg.name})` : ""
    const spreads = [...names].sort().map((name) => `...${name}`).join(" ")
    const eventFields = changeKind ? `${action.name} ${changeKind.name}` : action.name
    const text = `subscription ${operationName}${variables} { ${fieldName}${argumentUse} { ${eventFields} ${entity.name} { ${spreads} } } }`
    const document: DocumentNode = {
      kind: Kind.DOCUMENT,
      definitions: [...parse(text).definitions, ...fragmentNodes.values()],
    }
    let operation: OperationArtifact
    let thinOperation: OperationArtifact | undefined
    const rereadFragments: string[] = []
    if (options.liveSelection === "as-written") {
      operation = compileDocuments(schema, [document], options, true).operations[operationName]!
    } else {
      const carried = new Set(keyFields)
      const type = schema.getType(typename) as GraphQLObjectType
      const version = versionFieldOf(type, options)
      if (version) carried.add(version)
      const inspect = (set: SelectionSetNode, fragment: string, stack = new Set<string>()) => {
        for (const selection of set.selections) {
          if (selection.kind === Kind.FRAGMENT_SPREAD) {
            if (!stack.has(selection.name.value)) {
              const next = new Set(stack).add(selection.name.value)
              inspect(fragmentNodes.get(selection.name.value)!.selectionSet, fragment, next)
            }
          } else if (selection.kind === Kind.INLINE_FRAGMENT) inspect(selection.selectionSet, fragment, stack)
          else {
            const name = selection.name.value
            const def = type.getFields()[name]
            const batch = selection.directives?.find(d => d.name.value === "batch")
            if (batch) {
              const fk = batch.arguments?.find(a => a.name.value === "foreignKey")?.value
              if (fk?.kind === Kind.STRING) carried.add(fk.value)
              continue
            }
            const excluded = name === NODE_ID || !!selection.selectionSet || !!selection.arguments?.length || !!def?.args.length
            if (excluded) {
              if (name !== NODE_ID) rereadFragments.push(fragment)
              options.onWarning?.(`Fragment ${fragment}: stream excludes ${typename}.${name}`)
            } else if (name !== "__typename") carried.add(name)
          }
        }
      }
      for (const name of names) inspect(fragmentNodes.get(name)!.selectionSet, name)
      // Other fragments on a held record may ask for fields absent from the live union.
      const compare = (set: SelectionSetNode, fragment: string, seen = new Set<string>()) => {
        for (const selection of set.selections) {
          if (selection.kind === Kind.FRAGMENT_SPREAD) {
            if (!seen.has(selection.name.value)) compare(fragmentNodes.get(selection.name.value)!.selectionSet, fragment, new Set(seen).add(selection.name.value))
          } else if (selection.kind === Kind.INLINE_FRAGMENT) compare(selection.selectionSet, fragment, seen)
          else if (!selection.directives?.some(d => d.name.value === "batch") && selection.name.value !== NODE_ID && selection.name.value !== "__typename" &&
            (selection.selectionSet || selection.arguments?.length || !carried.has(selection.name.value))) rereadFragments.push(fragment)
        }
      }
      for (const fragment of Object.values(fragments)) {
        if (fragment.typeCondition === typename) compare(fragmentNodes.get(fragment.name)!.selectionSet, fragment.name)
      }
      const build = (fields: readonly string[]) => {
        const source = `subscription ${operationName}${variables} { ${fieldName}${argumentUse} { ${eventFields} ${entity.name} { ${fields.join(" ")} } } }`
        return compileDocuments(schema, [source], { ...options, streamProjection: true } as ProjectionOptions, true).operations[operationName]!
      }
      operation = build([...carried])
      thinOperation = build(keyFields)
    }
    live[typename] = {
      typename,
      mode,
      field: fieldName,
      entityField: entity.name,
      actionField: action.name,
      ...(changeKind ? { changeKindField: changeKind.name } : {}),
      keyArgument: arg?.name ?? null,
      keyFields,
      keyOptional: arg !== undefined && !isNonNullType(arg.type),
      operation,
      ...(thinOperation ? { thinOperation, rereadFragments: [...new Set(rereadFragments)] } : {}),
    }
  }
  return { live, liveUnavailable: liveUnavailable.sort() }
}

/**
 * A type's usable `Changed` subscription: an object payload with the entity and an action, and no
 * required argument besides the key. It says nothing about whether the type has a key.
 */
function changedStreamOf(schema: GraphQLSchema, typename: string, options: CompileOptions) {
  const fieldName = options.liveField?.(typename) ?? `${typename}Changed`
  const field = schema.getSubscriptionType()?.getFields()[fieldName]
  const payload = field ? getNamedType(field.type) : undefined
  if (!field || !payload || !isObjectType(payload)) return undefined
  const payloadFields = Object.values(payload.getFields())
  const entity = payloadFields.find((candidate) => getNamedType(candidate.type).name === typename)
  const action = payloadFields.find((candidate) => candidate.name.toLowerCase() === "action")
  const changeKind = payloadFields.find((candidate) => candidate.name.toLowerCase() === "changekind")
  if (!entity || !action) return undefined
  const keysArg = field.args.find((arg) => arg.name.toLowerCase() === "keys")
  const keyArg = field.args.find((arg) => arg.name.toLowerCase() === "key")
  const mode: LiveMode = keysArg ? "keys" : keyArg ? "key" : "unkeyed"
  const arg = keysArg ?? keyArg
  // A stream needing another required argument cannot be generated from the ORM key contract.
  if (field.args.some((candidate) => candidate !== arg && isNonNullType(candidate.type) && candidate.defaultValue === undefined)) return undefined
  return { fieldName, entity, action, changeKind, arg, mode }
}

/** Why a type with a usable `Changed` stream still can't be live (it has no key), and how to give it one. */
function keylessCause(typename: string, options: CompileOptions): { cause: string; fix: string } {
  return options.keys && typename in options.keys
    ? { cause: `its identity is configured off (keys: { ${typename}: null })`, fix: "Remove that keys entry or name its key fields" }
    : { cause: `the compiler finds no key fields for it (no Id field and no ${typename}KeyInput)`, fix: `Name them in keys: { ${typename}: [...] }` }
}

/**
 * Where a fragment, or a fragment it spreads, uses an operation variable: in a field's arguments or
 * directives, or in a directive on a fragment spread or inline fragment.
 */
function variableUses(
  schema: GraphQLSchema,
  fragmentNodes: ReadonlyMap<string, FragmentDefinitionNode>,
  name: string
): { site: string; verb: "takes" | "uses"; fragment: string; variable: string }[] {
  const uses: { site: string; verb: "takes" | "uses"; fragment: string; variable: string }[] = []
  const note = (node: import("graphql").ASTNode, site: string, verb: "takes" | "uses", fragment: string) => {
    const variables = new Set<string>()
    visit(node, { Variable(variable) { variables.add(variable.name.value) } })
    for (const variable of variables) uses.push({ site, verb, fragment, variable })
  }
  const seen = new Set<string>()
  const walk = (set: SelectionSetNode, parent: GraphQLCompositeType | undefined, fragment: string) => {
    for (const selection of set.selections) {
      if (selection.kind === Kind.FRAGMENT_SPREAD) {
        for (const directive of selection.directives ?? []) note(directive, `the spread ...${selection.name.value}`, "uses", fragment)
        const spread = fragmentNodes.get(selection.name.value)
        if (spread && !seen.has(spread.name.value)) {
          seen.add(spread.name.value)
          walk(spread.selectionSet, schema.getType(spread.typeCondition.name.value) as GraphQLCompositeType, spread.name.value)
        }
      } else if (selection.kind === Kind.INLINE_FRAGMENT) {
        const target = selection.typeCondition ? schema.getType(selection.typeCondition.name.value) as GraphQLCompositeType : parent
        for (const directive of selection.directives ?? []) note(directive, `an inline fragment on ${target?.name ?? "?"}`, "uses", fragment)
        walk(selection.selectionSet, target, fragment)
      } else {
        const def = parent && "getFields" in parent ? parent.getFields()[selection.name.value] : undefined
        note({ ...selection, selectionSet: undefined }, `${parent?.name ?? "?"}.${selection.name.value}`, "takes", fragment)
        if (selection.selectionSet) walk(selection.selectionSet, def ? getNamedType(def.type) as GraphQLCompositeType : undefined, fragment)
      }
    }
  }
  const node = fragmentNodes.get(name)!
  seen.add(name)
  walk(node.selectionSet, schema.getType(node.typeCondition.name.value) as GraphQLCompositeType, name)
  return uses
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

function connectionSpec(
  node: FieldNode,
  options: CompileOptions,
  fieldDef?: { readonly args: readonly { readonly name: string; readonly type: import("graphql").GraphQLInputType }[] }
): ConnectionSpec | undefined {
  const directive = (node.directives ?? []).find((entry) => entry.name.value === "connection")
  if (!directive) return undefined
  const keyArg = directive.arguments?.find((arg) => arg.name.value === "key")
  const pagingArg = directive.arguments?.find((arg) => arg.name.value === "paging")
  const key = keyArg?.value.kind === Kind.STRING ? keyArg.value.value : node.name.value
  const paging =
    pagingArg?.value.kind === Kind.LIST
      ? pagingArg.value.values.flatMap((value) => (value.kind === Kind.STRING ? [value.value] : []))
      : undefined
  const spec: ConnectionSpec = { ...DEFAULT_CONNECTION, ...options.connection, key, ...(paging ? { paging } : {}) }
  // graphql-orm's offset PageInput (Limit, Offset) has no cursor: continue at the rows loaded.
  const pagingType = fieldDef?.args.find((arg) => arg.name === spec.paging[0])?.type
  const pagingInput = pagingType ? getNamedType(pagingType) : undefined
  const offset = options.connection?.offset ?? DEFAULT_PAGED.offset
  if (pagingInput && isInputObjectType(pagingInput)) {
    const fields = pagingInput.getFields()
    if (offset in fields && !(spec.after in fields)) return { ...spec, offset, limit: Object.keys(fields).find((name) => name.toLowerCase() === "limit") }
  }
  return { ...spec, ...(pagingInput && isInputObjectType(pagingInput) ? { limit: Object.keys(pagingInput.getFields()).find((name) => name.toLowerCase() === "limit") } : {}) }
}

/** A `@paged` list needs its page info: the total, and whether there are pages either side. */
function ensurePagedFields(
  selectionSet: SelectionSetNode,
  connection: GraphQLCompositeType,
  names: PagedNames
): SelectionSetNode {
  const pageInfoField = "getFields" in connection ? connection.getFields()[names.pageInfo] : undefined
  const pageInfoType = pageInfoField ? getNamedType(pageInfoField.type) : undefined
  if (!pageInfoType || !isObjectType(pageInfoType)) return selectionSet
  const available = pageInfoType.getFields()
  const wanted = [names.totalCount, names.hasNextPage, names.hasPreviousPage].filter((name) => name in available)
  const index = selectionSet.selections.findIndex(
    (entry) => entry.kind === Kind.FIELD && entry.name.value === names.pageInfo && !entry.alias
  )
  const existing = index >= 0 ? (selectionSet.selections[index] as FieldNode) : field(names.pageInfo)
  const inner = existing.selectionSet ?? { kind: Kind.SELECTION_SET, selections: [] }
  const present = new Set(inner.selections.flatMap((entry) => (entry.kind === Kind.FIELD && !entry.alias ? [entry.name.value] : [])))
  const updated: FieldNode = {
    ...existing,
    selectionSet: { ...inner, selections: [...inner.selections, ...wanted.filter((name) => !present.has(name)).map(field)] },
  }
  const selections = [...selectionSet.selections]
  if (index >= 0) selections[index] = updated
  else selections.push(updated)
  return { ...selectionSet, selections }
}

function hasDirective(selectionSet: SelectionSetNode, name: string): boolean {
  let found = false
  visit(selectionSet, {
    Directive(directive) {
      if (directive.name.value === name) found = true
    },
  })
  return found
}

/**
 * The operation's `@paged` field: where it sits in the data, and the page variable it takes. The
 * field must be in the operation itself, under no list, and take graphql-orm's offset page input
 * (`Limit`, `Offset`) as a variable.
 */
function pagedSpecOf(
  schema: GraphQLSchema,
  operation: OperationDefinitionNode,
  rootType: GraphQLObjectType,
  options: CompileOptions
): PagedSpec | undefined {
  const names = pagedNames(options)
  const name = operation.name?.value ?? "operation"
  const found: { node: FieldNode; path: string[]; parent: GraphQLCompositeType; underList: boolean }[] = []
  const walk = (set: SelectionSetNode, parent: GraphQLCompositeType, path: string[], underList: boolean) => {
    for (const selection of set.selections) {
      if (selection.kind === Kind.INLINE_FRAGMENT) {
        const target = selection.typeCondition
          ? (schema.getType(selection.typeCondition.name.value) as GraphQLCompositeType)
          : parent
        walk(selection.selectionSet, target, path, underList)
        continue
      }
      if (selection.kind !== Kind.FIELD || !selection.selectionSet) continue
      const fieldDef = "getFields" in parent ? parent.getFields()[selection.name.value] : undefined
      if (!fieldDef) continue
      const next = [...path, selection.alias?.value ?? selection.name.value]
      if ((selection.directives ?? []).some((directive) => directive.name.value === "paged"))
        found.push({ node: selection, path: next, parent, underList })
      walk(selection.selectionSet, getNamedType(fieldDef.type) as GraphQLCompositeType, next, underList || isPlural(fieldDef.type))
    }
  }
  walk(operation.selectionSet, rootType, [], false)
  if (found.length === 0) return undefined
  const problems: string[] = []
  if (found.length > 1) problems.push(`${name} marks more than one field @paged`)
  const [{ node, path, parent, underList }] = found as [(typeof found)[number]]
  const at = `${name}'s @paged field ${path.join(".")}`
  if (underList) problems.push(`${at} is inside a list`)
  if ((node.directives ?? []).some((directive) => directive.name.value === "connection"))
    problems.push(`${at} can't also be a @connection`)
  const directive = node.directives!.find((entry) => entry.name.value === "paged")!
  const pagingArg = directive.arguments?.find((arg) => arg.name.value === "paging")
  const paging = pagingArg?.value.kind === Kind.STRING ? pagingArg.value.value : "Page"
  const argument = node.arguments?.find((arg) => arg.name.value === paging)
  const fieldDef = (parent as GraphQLObjectType).getFields()[node.name.value]!
  const inputType = fieldDef.args.find((arg) => arg.name === paging)?.type
  const input = inputType ? getNamedType(inputType) : undefined
  if (!input || !isInputObjectType(input) || !(names.limit in input.getFields()) || !(names.offset in input.getFields()))
    problems.push(`${at} needs a ${paging} argument with ${names.limit} and ${names.offset} (graphql-orm's PageInput)`)
  if (argument?.value.kind !== Kind.VARIABLE)
    problems.push(`${at} must take its ${paging} argument as a variable, for example ${paging}: $${paging}`)
  const connection = getNamedType(fieldDef.type)
  const connectionFields = isObjectType(connection) ? connection.getFields() : {}
  const pageInfo = connectionFields[names.pageInfo] ? getNamedType(connectionFields[names.pageInfo]!.type) : undefined
  const pageInfoFields = pageInfo && isObjectType(pageInfo) ? pageInfo.getFields() : {}
  if (!(names.edges in connectionFields) || !(names.totalCount in pageInfoFields) || !(names.hasNextPage in pageInfoFields))
    problems.push(`${at} must return a connection with ${names.edges} and ${names.pageInfo} { ${names.totalCount} ${names.hasNextPage} }`)
  if (problems.length) throw new CompileError(problems)
  return {
    path,
    variable: (argument!.value as import("graphql").VariableNode).name.value,
    limit: names.limit,
    offset: names.offset,
    edges: names.edges,
    pageInfo: names.pageInfo,
    totalCount: names.totalCount,
    hasNextPage: names.hasNextPage,
    hasPreviousPage: names.hasPreviousPage in pageInfoFields ? names.hasPreviousPage : null,
  }
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
      const isPaged = (selection.directives ?? []).some((directive) => directive.name.value === "paged")
      const selectionSet = isConnection
        ? ensureConnectionFields(selection.selectionSet, { ...DEFAULT_CONNECTION, ...options.connection })
        : isPaged
          ? ensurePagedFields(selection.selectionSet, named, pagedNames(options))
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
  for (const node of selections) {
    if (node.kind !== Kind.FIELD) continue
    const batch = node.directives?.find(d => d.name.value === "batch")
    const fk = batch?.arguments?.find(a => a.name.value === "foreignKey")?.value
    if (fk?.kind === Kind.STRING && !present.has(fk.value)) additions.push(field(fk.value))
  }
  if (!present.has("__typename")) additions.push(field("__typename"))
  const { streamProjection, readSelection } = options as ProjectionOptions
  if (!streamProjection && !readSelection && hasNodeId(parent) && !present.has(NODE_ID)) additions.push(field(NODE_ID))
  if (isObjectType(parent)) {
    const lifetime = options.lifetimes?.[parent.name]
    if (lifetime) {
      const definition = parent.getFields()[lifetime.field]
      if (!definition || definition.args.length || !["String", "Int", "Float"].includes(getNamedType(definition.type).name))
        throw new CompileError([`Invalid lifetime field ${parent.name}.${lifetime.field}`])
      if (!["unix-seconds", "rfc3339", "sqlite-utc"].includes(lifetime.format))
        throw new CompileError([`Invalid lifetime format for ${parent.name}`])
      if (!present.has(lifetime.field)) additions.push(field(lifetime.field))
    }
    if (!readSelection) for (const key of keyFieldsOf(schema, parent.name, options) ?? []) {
      if (!present.has(key)) additions.push(field(key))
    }
    if (!streamProjection && !readSelection && versionFieldOf(parent, options) === RECORD_VERSION && !present.has(RECORD_VERSION)) {
      additions.push(field(RECORD_VERSION))
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

/** Key and version fields of every object type, and the version fields compared other than as numbers. */
function typeMetadata(
  schema: GraphQLSchema,
  options: CompileOptions
): { keys: Record<string, readonly string[]>; versions: Record<string, string>; versionCompare: Record<string, "decimal"> } {
  const keys: Record<string, readonly string[]> = {}
  const versions: Record<string, string> = {}
  const versionCompare: Record<string, "decimal"> = {}
  const problems: string[] = []
  for (const type of Object.values(schema.getTypeMap())) {
    if (!isObjectType(type) || type.name.startsWith("__")) continue
    const fields = keyFieldsOf(schema, type.name, options)
    if (fields) keys[type.name] = fields
    const configured = options.versions?.[type.name]
    const problem = configured === undefined || configured === null ? null : versionProblem(type, configured)
    if (problem) {
      problems.push(problem)
      continue
    }
    const version = versionPolicyOf(type, options)
    if (version) versions[type.name] = version.field
    if (version?.compare === "decimal") versionCompare[type.name] = "decimal"
  }
  if (problems.length) throw new CompileError(problems)
  return { keys, versions, versionCompare }
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
      if (!selection.selectionSet && selection.directives?.some(d => d.name.value === "batch"))
        throw new CompileError([`${parent.name}.${name}: @batch requires a singular relation selection`])
      if (name === "__typename" || !selection.selectionSet) {
        result.push({ kind: "scalar", responseKey, fieldName: name, args })
        continue
      }
      const fieldDef = "getFields" in parent ? parent.getFields()[name] : undefined
      if (!fieldDef) throw new CompileError([`${parent.name}.${name} does not exist`])
      const named = getNamedType(fieldDef.type) as GraphQLCompositeType
      const batch = batchSpec(schema, parent, selection, named, fragments, options)
      const connectionNames = { ...DEFAULT_CONNECTION, ...options.connection }
      const edgeNode = name === connectionNames.edges && isObjectType(named) && named.getFields()[connectionNames.node]
        ? selection.selectionSet.selections.find((s): s is FieldNode => s.kind === Kind.FIELD && s.name.value === connectionNames.node)
        : undefined
      result.push({
        kind: "link",
        ...(edgeNode ? { listNode: edgeNode.alias?.value ?? edgeNode.name.value } : {}),
        responseKey,
        fieldName: name,
        args,
        ...(batch ? { batch } : {}),
        plural: isPlural(fieldDef.type),
        types: possibleTypes(schema, named),
        selections: convert(schema, selection.selectionSet, named, fragments, inlineSpreads, options),
        ...(connectionSpec(selection, options, fieldDef) ? { connection: connectionSpec(selection, options, fieldDef)! } : {}),
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

/** Read connection identity from schema structure, even when the document selects only totals. */
function listTypes(schema: GraphQLSchema, selections: readonly Selection[], parent: GraphQLCompositeType, options: CompileOptions): string[] {
  const names = { ...DEFAULT_CONNECTION, ...options.connection }
  const result = new Set<string>()
  const add = (type: import("graphql").GraphQLNamedType) => {
    if (isObjectType(type)) result.add(type.name)
    else if (isAbstractType(type)) for (const possible of schema.getPossibleTypes(type)) result.add(possible.name)
  }
  for (const selection of selections) {
    if (selection.kind === "inline") for (const name of listTypes(schema, selection.selections, selection.typeCondition ? schema.getType(selection.typeCondition) as GraphQLCompositeType : parent, options)) result.add(name)
    if (selection.kind !== "link" || !("getFields" in parent)) continue
    const field = parent.getFields()[selection.fieldName]
    if (!field) continue
    const type = getNamedType(field.type)
    const unwrapped = isNonNullType(field.type) ? field.type.ofType : field.type
    // Generated aggregates share their result objects across entities. The root name cannot
    // identify their source; a unique shared filter input with a connection root can.
    if (isListType(unwrapped) && isObjectType(type) && type.name === "GraphqlAggregateResultRow") {
      const candidates = new Set<string>()
      const inputs = new Set(field.args.map(arg => getNamedType(arg.type)).filter(isInputObjectType))
      for (const candidate of Object.values(parent.getFields())) {
        if (!candidate.args.some(arg => inputs.has(getNamedType(arg.type) as import("graphql").GraphQLInputObjectType))) continue
        const connection = getNamedType(candidate.type)
        if (!isObjectType(connection)) continue
        const edgeField = connection.getFields()[names.edges]
        const edgeType = edgeField && getNamedType(edgeField.type)
        const nodeField = edgeType && isObjectType(edgeType) ? edgeType.getFields()[names.node] : undefined
        if (nodeField) candidates.add(getNamedType(nodeField.type).name)
      }
      if (candidates.size === 1) add(schema.getType([...candidates][0]!)!)
    } else if (isListType(unwrapped)) add(type)
    if (isObjectType(type)) {
      const edges = type.getFields()[names.edges]
      const edge = edges && getNamedType(edges.type)
      const node = edge && isObjectType(edge) ? edge.getFields()[names.node] : undefined
      if (node) add(getNamedType(node.type))
    }
    if (isCompositeType(type)) for (const name of listTypes(schema, selection.selections, type, options)) result.add(name)
  }
  return [...result].sort()
}

function batchSpec(schema: GraphQLSchema, parent: GraphQLCompositeType, node: FieldNode, target: GraphQLCompositeType, fragments: ReadonlyMap<string, FragmentDefinitionNode>, options: CompileOptions): import("../artifact.js").BatchSpec | undefined {
  const directive = node.directives?.find(d => d.name.value === "batch")
  if (!directive) return
  const fail = (why: string): never => { throw new CompileError([`${parent.name}.${node.name.value}: @batch ${why}`]) }
  const arg = (name: string): string => {
    const value = directive.arguments?.find(a => a.name.value === name)?.value
    return value?.kind === Kind.STRING ? value.value : fail(`requires literal ${name}`)
  }
  const foreignKey = arg("foreignKey"), root = arg("root"), key = arg("key")
  const limitNode = directive.arguments?.find(a => a.name.value === "limit")?.value
  const limit = limitNode?.kind === Kind.INT ? Number(limitNode.value) : 100
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) fail("limit must be 1–100")
  if (!isObjectType(parent) || !isObjectType(target)) return fail("requires concrete parent and target types")
  const relation = parent.getFields()[node.name.value]!
  if (isPlural(relation.type) || node.arguments?.length || node.directives?.some(d => d.name.value !== "batch")) fail("requires an unconditional singular relation without arguments")
  const keys = keyFieldsOf(schema, target.name, options)
  if (keys?.length !== 1 || keys[0] !== key) fail(`${target.name}.${key} must be its complete single-field key`)
  const fk = parent.getFields()[foreignKey], pk = target.getFields()[key]
  if (!fk || !pk || getNamedType(fk.type) !== getNamedType(pk.type) || isPlural(fk.type)) fail(`foreign key ${foreignKey} must have the target key's scalar type`)
  const rootField = schema.getQueryType()?.getFields()[root]
  if (!rootField) return fail(`list root ${root} does not exist`)
  const where = rootField.args.find(a => a.name === "Where"), page = rootField.args.find(a => a.name === "Page")
  const whereType = where && getNamedType(where.type)
  const filter = whereType && isInputObjectType(whereType) && whereType.getFields()[key]
  const filterType = filter && getNamedType(filter.type)
  const inList = filterType && isInputObjectType(filterType) && filterType.getFields().InList
  if (!inList || getNamedType(inList.type) !== getNamedType(pk!.type)) fail(`root ${root} needs Where.${key}.InList with the target key's type`)
  if (!where || !page) return fail(`root ${root} needs Where and Page inputs`)
  const pageType = getNamedType(page.type)
  if (!isInputObjectType(pageType) || !pageType.getFields().Limit || getNamedType(pageType.getFields().Limit!.type).name !== "Int") fail(`root ${root} needs Page.Limit: Int`)
  const listType = inList && (isNonNullType(inList.type) ? inList.type.ofType : inList.type)
  if (!listType || !isListType(listType)) fail(`root ${root} needs an InList list input`)
  const used = usedFragments(node.selectionSet!, fragments)
  if ([...used].some(n => hasDirective(fragments.get(n)!.selectionSet, "batch")) || hasDirective(node.selectionSet!, "batch")) fail("nested batches are not supported")
  const selection = print(node.selectionSet!)
  const sources = [`query Batch_${parent.name}_${node.name.value}($Where: ${where.type}, $Page: ${page.type}) { ${root}(Where: $Where, Page: $Page) { Edges { Node ${selection} } } }`, ...[...used].map(n => print(fragments.get(n)!))]
  let operation: OperationArtifact
  try { operation = compileDocuments(schema, sources, options, true).operations[`Batch_${parent.name}_${node.name.value}`]! }
  catch (error) { return fail(error instanceof Error ? error.message : String(error)) }
  // Validation above also checks Edges.Node and Page.Limit against the served schema.
  const rootType = getNamedType(rootField.type)
  const edges = isObjectType(rootType) && rootType.getFields().Edges
  const edge = edges && getNamedType(edges.type)
  const resultNode = edge && isObjectType(edge) && edge.getFields().Node
  if (!resultNode || getNamedType(resultNode.type) !== target) fail(`root ${root} does not return ${target.name}`)
  return { foreignKey, key, operation, limit }
}

// All batch sites for the same declared root share one build-time projection and cache key.
function shareBatches(schema: GraphQLSchema, operations: Record<string, OperationArtifact>, fragments: Record<string, FragmentArtifact>, options: CompileOptions): void {
  const groups = new Map<string, import("../artifact.js").BatchSpec[]>()
  const visited = new Set<Selection>()
  const walk = (selections: readonly Selection[]) => {
    for (const selection of selections) {
      if (visited.has(selection)) continue
      visited.add(selection)
      if (selection.kind === "link" && selection.batch) {
        const spec = selection.batch
        const root = spec.operation.normalization.find((s): s is import("../artifact.js").LinkSelection => s.kind === "link")!
        const key = `${root.fieldName}:${spec.key}`
        const group = groups.get(key) ?? []
        group.push(spec); groups.set(key, group)
      }
      if (selection.kind === "inline" || selection.kind === "link") walk(selection.selections)
    }
  }
  for (const operation of Object.values(operations)) { walk(operation.selections); walk(operation.normalization) }
  for (const fragment of Object.values(fragments)) walk(fragment.selections)
  for (const group of groups.values()) {
    const definitions = group.flatMap(spec => parse(spec.operation.text).definitions)
    const roots = definitions.filter(d => d.kind === Kind.OPERATION_DEFINITION)
    const allNodeSelections = roots.flatMap(root => {
      const connection = root.selectionSet.selections[0] as FieldNode
      const edges = connection.selectionSet!.selections.find(s => s.kind === Kind.FIELD && s.name.value === "Edges") as FieldNode
      const node = edges.selectionSet!.selections.find(s => s.kind === Kind.FIELD && s.name.value === "Node") as FieldNode
      return node.selectionSet!.selections
    })
    const nodeSelections = [...new Map(allNodeSelections.map(node => [print(node), node])).values()]
    const root = roots[0]!
    const connection = root.selectionSet.selections[0] as FieldNode
    const edges = connection.selectionSet!.selections.find(s => s.kind === Kind.FIELD && s.name.value === "Edges") as FieldNode
    const targetNode = edges.selectionSet!.selections.find(s => s.kind === Kind.FIELD && s.name.value === "Node")
    const combined = visit(root, { Field(node) { if (node === targetNode) return { ...node, selectionSet: { kind: Kind.SELECTION_SET, selections: nodeSelections } } } })
    const uniqueFragments = new Map(definitions.filter(d => d.kind === Kind.FRAGMENT_DEFINITION).map(d => [d.name.value, d]))
    const operation = compileDocuments(schema, [{kind: Kind.DOCUMENT, definitions: [combined, ...uniqueFragments.values()]}], options, true).operations[root.name!.value]!
    for (const spec of group) Object.assign(spec, { operation, limit: Math.min(...group.map(s => s.limit)) })
  }
}

/** Match a config-relative POSIX path using *, ** and ? globs (no brace or extglob syntax). */
export function matchesPath(path: string, glob: string): boolean {
  const pattern = glob.replaceAll("\\", "/").replace(/^\.\//, "")
  let expression = ""
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!
    if (c === "*" && pattern[i + 1] === "*") {
      i++
      if (pattern[i + 1] === "/") { i++; expression += "(?:.*/)?" }
      else expression += ".*"
    } else if (c === "*") expression += "[^/]*"
    else if (c === "?") expression += "[^/]"
    else expression += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  }
  return new RegExp(`^${expression}$`).test(path.replaceAll("\\", "/").replace(/^\.\//, ""))
}

function pollReason(node: FragmentDefinitionNode | OperationDefinitionNode): string | undefined {
  const value = node.directives?.find((d) => d.name.value === "poll")?.arguments?.find((a) => a.name.value === "reason")?.value
  return value?.kind === Kind.STRING && value.value.trim() ? value.value : undefined
}
