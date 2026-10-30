import { createHash } from "node:crypto"
import {
  Kind,
  extendSchema,
  getNamedType,
  isAbstractType,
  isCompositeType,
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
  FragmentArtifact,
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
}

export interface CompileResult {
  readonly operations: Readonly<Record<string, OperationArtifact>>
  readonly fragments: Readonly<Record<string, FragmentArtifact>>
}

export class CompileError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`GraphQL documents failed to compile:\n${problems.join("\n")}`)
    this.name = "CompileError"
  }
}

const CLIENT_DIRECTIVES = parse(`directive @live on FRAGMENT_DEFINITION`)

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
      selections: convert(schema, augmented.selectionSet, parent, fragmentNodes, false),
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
      .map((definition) => print(definition))
      .join("\n\n")
    const reachable = reachableTypes(convert(schema, augmented.selectionSet, rootType, augmentedFragments, true))
    operations[name] = {
      kind: node.operation,
      keys: pick(metadata.keys, reachable),
      versions: pick(metadata.versions, reachable),
      name,
      text,
      hash: createHash("sha256").update(text).digest("hex"),
      rootType: rootType.name,
      selections: convert(schema, augmented.selectionSet, rootType, fragmentNodes, false),
      normalization: convert(schema, augmented.selectionSet, rootType, augmentedFragments, true),
      fragments: Object.fromEntries([...used].sort().map((fragment) => [fragment, fragments[fragment]!])),
    }
  }
  return { operations, fragments }
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
      return { ...selection, selectionSet: augmentSelectionSet(schema, selection.selectionSet, named, options) }
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
  inlineSpreads: boolean
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
        selections: convert(schema, selection.selectionSet, named, fragments, inlineSpreads),
      })
    } else if (selection.kind === Kind.INLINE_FRAGMENT) {
      const typeCondition = selection.typeCondition?.name.value ?? null
      const target = typeCondition ? (schema.getType(typeCondition) as GraphQLCompositeType) : parent
      result.push({
        kind: "inline",
        typeCondition,
        possibleTypes: typeCondition ? possibleTypes(schema, target) : null,
        selections: convert(schema, selection.selectionSet, target, fragments, inlineSpreads),
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
          selections: convert(schema, definition.selectionSet, target, fragments, true),
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
