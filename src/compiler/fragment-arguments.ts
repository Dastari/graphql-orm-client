/**
 * Fragment arguments: `@argumentDefinitions` on a fragment declares local arguments, and `@arguments` on a spread passes
 * them. Both are client-only. The text sent to the server has one copy of the fragment per argument set, named
 * `<Fragment>_<hash>`, with the values written in, so it is ordinary GraphQL. Readers keep one artifact per fragment and
 * resolve its arguments at run time, from what the spread passed.
 *
 * Relay's directive syntax is used because graphql 16 and 17 both parse it with default options. graphql 16 parses
 * variable definitions on a fragment only behind `allowLegacyFragmentVariables`, and has no syntax for passing them; graphql
 * 17's fragment arguments are behind an experimental parser option.
 */
import { createHash } from "node:crypto"
import {
  Kind,
  VariablesInAllowedPositionRule,
  getNamedType,
  isInputObjectType,
  isInputType,
  isListType,
  isNonNullType,
  isTypeSubTypeOf,
  parseType,
  print,
  typeFromAST,
  validate,
  valueFromAST,
  visit,
  type ASTNode,
  type ConstValueNode,
  type DirectiveNode,
  type FragmentDefinitionNode,
  type FragmentSpreadNode,
  type GraphQLInputType,
  type GraphQLSchema,
  type OperationDefinitionNode,
  type SelectionSetNode,
  type TypeNode,
  type ValueNode,
  type VariableDefinitionNode,
} from "graphql"
import { hasDefault, printStable } from "./print.js"

/** One argument a fragment declares with `@argumentDefinitions`. */
export interface FragmentArgument {
  readonly name: string
  readonly type: GraphQLInputType
  readonly typeNode: TypeNode
  readonly defaultValue?: ConstValueNode
}

/** What each fragment definition declares, by node. Filled by `applyFragmentArguments` for the nodes it was given. */
const declarations = new WeakMap<FragmentDefinitionNode, readonly FragmentArgument[]>()

/** The arguments a fragment declares, or undefined when it declares none. */
export function declaredArguments(fragment: FragmentDefinitionNode): readonly FragmentArgument[] | undefined {
  return declarations.get(fragment)
}

/**
 * The value of each argument a fragment declares at one spread of it: what the spread passes, else the declared default,
 * else null. Undefined when the fragment declares no arguments. Values are in the spreading scope's terms.
 */
export function spreadValues(fragment: FragmentDefinitionNode, spread: FragmentSpreadNode): readonly (readonly [string, ValueNode])[] | undefined {
  const declared = declarations.get(fragment)
  if (!declared) return undefined
  const passed = new Map((argumentsDirective(spread)?.arguments ?? []).map((argument) => [argument.name.value, argument.value]))
  return declared.map((argument) => [argument.name, passed.get(argument.name) ?? argument.defaultValue ?? NULL] as const)
}

/** The name a reader resolves a fragment's local argument under. It has a dot, so it can't be an operation variable's name. */
export function scopedName(fragment: string, argument: string): string {
  return `${fragment}.${argument}`
}

const NULL: ValueNode = { kind: Kind.NULL }

function argumentsDirective(spread: FragmentSpreadNode): DirectiveNode | undefined {
  return spread.directives?.find((directive) => directive.name.value === "arguments")
}

/** Whether any definition declares or passes fragment arguments. When none does, the documents are compiled as written. */
export function usesFragmentArguments(definitions: readonly ASTNode[]): boolean {
  let found = false
  for (const definition of definitions) {
    visit(definition, {
      Directive(directive) {
        if (directive.name.value === "argumentDefinitions" || directive.name.value === "arguments") found = true
      },
    })
    if (found) return true
  }
  return false
}

export interface AppliedArguments {
  /** Each operation with its spreads renamed to the copies they read. */
  readonly operations: ReadonlyMap<OperationDefinitionNode, OperationDefinitionNode>
  /**
   * Every fragment as sent: one without arguments under its own name, one with arguments once per argument set under its
   * copy's name, and, under its own name, a copy with the arguments left as variables, so a fragment no operation spreads
   * is still checked against the schema.
   */
  readonly fragments: ReadonlyMap<string, FragmentDefinitionNode>
  readonly problems: readonly string[]
}

/**
 * Check fragment argument declarations and spreads, and write out a copy of each fragment per argument set, so the
 * documents can be validated and sent as ordinary GraphQL.
 */
export function applyFragmentArguments(
  schema: GraphQLSchema,
  operations: readonly OperationDefinitionNode[],
  fragments: ReadonlyMap<string, FragmentDefinitionNode>
): AppliedArguments {
  const problems: string[] = []
  const byName = new Map<string, readonly FragmentArgument[]>()
  for (const [name, node] of fragments) {
    const found = (node.directives ?? []).filter((directive) => directive.name.value === "argumentDefinitions")
    if (found.length > 1) problems.push(`Fragment ${name} has more than one @argumentDefinitions`)
    if (!found.length) {
      declarations.delete(node)
      continue
    }
    const declared = declarationsOf(schema, name, found[0]!, problems)
    declarations.set(node, declared)
    byName.set(name, declared)
  }
  for (const node of [...operations, ...fragments.values()]) misplaced(node, problems)
  for (const operation of operations) {
    const variables = new Map((operation.variableDefinitions ?? []).map((definition) => [definition.variable.name.value, definition]))
    checkSpreads(schema, operation.selectionSet, `operation ${operation.name?.value ?? "<anonymous>"}`, fragments, (name) => {
      const definition = variables.get(name)
      const type = definition && typeFromAST(schema, definition.type)
      return type && isInputType(type) ? { type, hasDefault: definition.defaultValue !== undefined } : undefined
    }, problems)
  }
  for (const [name, node] of fragments) {
    const locals = new Map((byName.get(name) ?? []).map((argument) => [argument.name, argument]))
    // A variable that isn't one of the fragment's arguments is an operation's, whose type each operation gives.
    checkSpreads(schema, node.selectionSet, `fragment ${name}`, fragments, (variable) => {
      const local = locals.get(variable)
      return local ? { type: local.type, hasDefault: local.defaultValue !== undefined } : undefined
    }, problems)
  }
  for (const [name, declared] of byName) checkPositions(schema, fragments.get(name)!, declared, problems)
  if (problems.length) return { operations: new Map(), fragments: new Map(), problems }

  const wire = new Map<string, FragmentDefinitionNode>()
  const active = new Set<string>()
  const rewrite = <T extends ASTNode>(node: T, bindings: ReadonlyMap<string, ValueNode> | null): T =>
    visit(node, {
      // Substituting whole values, so a bound value's own variables, the operation's, are never substituted again.
      Argument(argument) {
        return bindings ? { ...argument, value: substitute(argument.value, bindings) } : undefined
      },
      FragmentSpread: {
        leave(spread) {
          const definition = fragments.get(spread.name.value)
          const directives = spread.directives?.filter((directive) => directive.name.value !== "arguments")
          if (!definition) return { ...spread, directives }
          const values = spreadValues(definition, spread)
          return { ...spread, directives, name: { kind: Kind.NAME, value: specialize(definition, values ? new Map(values) : null) } }
        },
      },
    }) as T
  const specialize = (definition: FragmentDefinitionNode, bindings: ReadonlyMap<string, ValueNode> | null): string => {
    const name = definition.name.value
    const key = bindings ? printStable({ kind: Kind.OBJECT, fields: [...bindings].map(([field, value]) => ({ kind: Kind.OBJECT_FIELD, name: { kind: Kind.NAME, value: field }, value })) }) : ""
    const copy = bindings ? `${name}_${createHash("sha256").update(`${name}${key}`).digest("hex").slice(0, 8)}` : name
    // A cycle is reported by validation; stop here instead of following it.
    if (wire.has(copy) || active.has(copy)) return copy
    if (bindings && fragments.has(copy)) {
      problems.push(`Fragment ${copy} has the name of the copy of fragment ${name} for the arguments ${key}; rename it`)
      return copy
    }
    active.add(copy)
    const body = rewrite(definition, bindings)
    active.delete(copy)
    wire.set(copy, { ...body, name: { kind: Kind.NAME, value: copy }, directives: withoutArgumentDefinitions(body.directives) })
    return copy
  }
  for (const definition of fragments.values()) {
    if (!declarations.has(definition)) specialize(definition, null)
  }
  const result = new Map(operations.map((operation) => [operation, rewrite(operation, null)]))
  for (const [name, definition] of fragments) {
    if (!declarations.has(definition)) continue
    // The arguments stay variables, and the spreads in it stay unspecialised: this copy is validated, never sent.
    const generic = visit(definition, {
      FragmentSpread(spread) {
        return { ...spread, directives: spread.directives?.filter((directive) => directive.name.value !== "arguments") }
      },
    })
    if (wire.has(name)) problems.push(`Fragment ${name}: its name is taken by the copy of another fragment; rename it`)
    wire.set(name, { ...generic, directives: withoutArgumentDefinitions(generic.directives) })
  }
  return { operations: result, fragments: wire, problems }
}

function withoutArgumentDefinitions(directives: readonly DirectiveNode[] | undefined): readonly DirectiveNode[] | undefined {
  return directives?.filter((directive) => directive.name.value !== "argumentDefinitions")
}

function substitute(value: ValueNode, bindings: ReadonlyMap<string, ValueNode>): ValueNode {
  switch (value.kind) {
    case Kind.VARIABLE:
      return bindings.get(value.name.value) ?? value
    case Kind.LIST:
      return { ...value, values: value.values.map((item) => substitute(item, bindings)) }
    case Kind.OBJECT:
      return { ...value, fields: value.fields.map((field) => ({ ...field, value: substitute(field.value, bindings) })) }
    default:
      return value
  }
}

function declarationsOf(schema: GraphQLSchema, fragment: string, directive: DirectiveNode, problems: string[]): FragmentArgument[] {
  const declared: FragmentArgument[] = []
  const shape = `as name: {type: "Int!", defaultValue: 10}, with defaultValue optional`
  for (const argument of directive.arguments ?? []) {
    const name = argument.name.value
    const at = `Fragment ${fragment} argument ${name}`
    if (declared.some((entry) => entry.name === name)) {
      problems.push(`${at} is declared more than once`)
      continue
    }
    const value = argument.value
    const fields = value.kind === Kind.OBJECT ? new Map(value.fields.map((field) => [field.name.value, field.value])) : null
    const typeValue = fields?.get("type")
    if (!fields || typeValue?.kind !== Kind.STRING || [...fields.keys()].some((key) => key !== "type" && key !== "defaultValue")) {
      problems.push(`${at}: declare it ${shape}`)
      continue
    }
    let typeNode: TypeNode
    try {
      typeNode = parseType(typeValue.value)
    } catch {
      problems.push(`${at}: "${typeValue.value}" is not a GraphQL type`)
      continue
    }
    const type = typeFromAST(schema, typeNode as never) as GraphQLInputType | undefined
    if (!type || !isInputType(type)) {
      problems.push(`${at}: ${typeValue.value} is not an input type in the schema`)
      continue
    }
    const defaultValue = fields.get("defaultValue")
    if (defaultValue !== undefined) {
      if (hasVariable(defaultValue)) {
        problems.push(`${at}: a default can't use a variable`)
        continue
      }
      if (valueFromAST(defaultValue, type) === undefined) {
        problems.push(`${at}: the default ${print(defaultValue)} is not a valid ${String(type)}`)
        continue
      }
    }
    declared.push({ name, type, typeNode, ...(defaultValue !== undefined ? { defaultValue: defaultValue as ConstValueNode } : {}) })
  }
  return declared
}

/** `@argumentDefinitions` belongs on a fragment definition and `@arguments` on a spread. */
function misplaced(node: OperationDefinitionNode | FragmentDefinitionNode, problems: string[]): void {
  const where = node.kind === Kind.FRAGMENT_DEFINITION ? `Fragment ${node.name.value}` : `Operation ${node.name?.value ?? "<anonymous>"}`
  visit(node, {
    enter(entry) {
      const directives = (entry as { directives?: readonly DirectiveNode[] }).directives ?? []
      for (const directive of directives) {
        if (directive.name.value === "argumentDefinitions" && entry.kind !== Kind.FRAGMENT_DEFINITION)
          problems.push(`${where}: @argumentDefinitions belongs on a fragment definition${entry === node ? "; an operation declares variables" : ""}`)
        if (directive.name.value === "arguments" && entry.kind !== Kind.FRAGMENT_SPREAD)
          problems.push(`${where}: @arguments belongs on a fragment spread`)
      }
    },
  })
}

type VariableType = { readonly type: GraphQLInputType; readonly hasDefault: boolean }

/**
 * Each spread's arguments: names the fragment declares, every required one passed, and values of the declared types. A
 * variable whose type isn't known here (an operation's, used in a fragment) is checked where the value lands, by validation
 * of the operation. Also refuses one fragment spread twice on one object with different arguments: the object's reference
 * holds one set of values per fragment.
 */
function checkSpreads(
  schema: GraphQLSchema,
  selectionSet: SelectionSetNode,
  where: string,
  fragments: ReadonlyMap<string, FragmentDefinitionNode>,
  variableOf: (name: string) => VariableType | undefined,
  problems: string[]
): void {
  const onObject = (set: SelectionSetNode, seen: Map<string, string>) => {
    for (const selection of set.selections) {
      if (selection.kind === Kind.FIELD) {
        if (selection.selectionSet) onObject(selection.selectionSet, new Map())
      } else if (selection.kind === Kind.INLINE_FRAGMENT) {
        onObject(selection.selectionSet, seen)
      } else {
        const name = selection.name.value
        const definition = fragments.get(name)
        if (!definition) continue
        checkSpread(schema, selection, definition, where, variableOf, problems)
        const values = spreadValues(definition, selection)
        if (!values) continue
        const key = values.map(([argument, value]) => `${argument}: ${print(value)}`).join(", ")
        const earlier = seen.get(name)
        if (earlier !== undefined && earlier !== key)
          problems.push(`${where}: fragment ${name} is spread twice on one object with different arguments (${earlier}) and (${key}); spread each under its own alias`)
        seen.set(name, key)
      }
    }
  }
  onObject(selectionSet, new Map())
}

function checkSpread(
  schema: GraphQLSchema,
  spread: FragmentSpreadNode,
  definition: FragmentDefinitionNode,
  where: string,
  variableOf: (name: string) => VariableType | undefined,
  problems: string[]
): void {
  const name = definition.name.value
  const declared = declarations.get(definition)
  const passed = argumentsDirective(spread)?.arguments ?? []
  const at = `${where}: the spread ...${name}`
  if (!declared) {
    if (passed.length) problems.push(`${at} passes @arguments, but fragment ${name} declares no arguments; add @argumentDefinitions to it`)
    return
  }
  const seen = new Set<string>()
  for (const argument of passed) {
    const argumentName = argument.name.value
    const declaration = declared.find((entry) => entry.name === argumentName)
    if (seen.has(argumentName)) problems.push(`${at} passes ${argumentName} more than once`)
    seen.add(argumentName)
    if (!declaration) {
      problems.push(`${at} passes ${argumentName}, which fragment ${name} doesn't declare; it declares ${declared.map((entry) => entry.name).join(", ") || "none"}`)
      continue
    }
    const problem = valueProblem(schema, argument.value, declaration.type, variableOf)
    if (problem) problems.push(`${at} passes ${argumentName}: ${problem}, where fragment ${name} declares ${argumentName}: ${String(declaration.type)}`)
  }
  for (const argument of declared) {
    if (isNonNullType(argument.type) && argument.defaultValue === undefined && !seen.has(argument.name))
      problems.push(`Fragment ${name} needs argument ${argument.name} (${String(argument.type)}): ${at} doesn't pass it in @arguments`)
  }
}

function hasVariable(value: ValueNode): boolean {
  if (value.kind === Kind.VARIABLE) return true
  if (value.kind === Kind.LIST) return value.values.some(hasVariable)
  if (value.kind === Kind.OBJECT) return value.fields.some((field) => hasVariable(field.value))
  return false
}

/** Why a value can't be passed where `type` is expected, or null when it can (or can't be told here). */
function valueProblem(schema: GraphQLSchema, value: ValueNode, type: GraphQLInputType, variableOf: (name: string) => VariableType | undefined, locationDefault = false): string | null {
  if (value.kind === Kind.VARIABLE) {
    const variable = variableOf(value.name.value)
    if (!variable) return null
    const allowed = isTypeSubTypeOf(schema, variable.type, type) ||
      (isNonNullType(type) && !isNonNullType(variable.type) && (variable.hasDefault || locationDefault) && isTypeSubTypeOf(schema, variable.type, type.ofType))
    return allowed ? null : `$${value.name.value} is ${String(variable.type)}`
  }
  if (!hasVariable(value)) return valueFromAST(value, type) === undefined ? `${print(value)} is not a valid ${String(type)}` : null
  if (isNonNullType(type)) return valueProblem(schema, value, type.ofType, variableOf)
  if (isListType(type)) {
    if (value.kind !== Kind.LIST) return valueProblem(schema, value, type.ofType, variableOf)
    for (const item of value.values) {
      const problem = valueProblem(schema, item, type.ofType, variableOf)
      if (problem) return problem
    }
    return null
  }
  const named = getNamedType(type)
  if (isInputObjectType(named)) {
    if (value.kind !== Kind.OBJECT) return `${print(value)} is not a valid ${named.name}`
    const fields = named.getFields()
    for (const field of value.fields) {
      const definition = fields[field.name.value]
      if (!definition) return `${named.name} has no field ${field.name.value}`
      const problem = valueProblem(schema, field.value, definition.type, variableOf, hasDefault(definition))
      if (problem) return problem
    }
    for (const definition of Object.values(fields)) {
      if (isNonNullType(definition.type) && !hasDefault(definition) && !value.fields.some((field) => field.name.value === definition.name))
        return `${print(value)} leaves out ${named.name}.${definition.name}, which is required`
    }
  }
  return null
}

/** Each argument is used only where its declared type is allowed, as an operation variable would be. */
function checkPositions(schema: GraphQLSchema, fragment: FragmentDefinitionNode, declared: readonly FragmentArgument[], problems: string[]): void {
  // Spreads go: a spread fragment's variables are its own arguments, or an operation's.
  const body = visit(fragment, { FragmentSpread: () => null })
  const operation: OperationDefinitionNode = {
    kind: Kind.OPERATION_DEFINITION,
    operation: "query" as OperationDefinitionNode["operation"],
    name: { kind: Kind.NAME, value: "FragmentArguments" },
    variableDefinitions: declared.map((argument): VariableDefinitionNode => ({
      kind: Kind.VARIABLE_DEFINITION,
      variable: { kind: Kind.VARIABLE, name: { kind: Kind.NAME, value: argument.name } },
      type: argument.typeNode,
      ...(argument.defaultValue ? { defaultValue: argument.defaultValue } : {}),
    })),
    selectionSet: { kind: Kind.SELECTION_SET, selections: [{ kind: Kind.FRAGMENT_SPREAD, name: fragment.name }] },
  }
  for (const error of validate(schema, { kind: Kind.DOCUMENT, definitions: [operation, body] }, [VariablesInAllowedPositionRule]))
    problems.push(`Fragment ${fragment.name.value}: ${error.message.replace(/^Variable "\$/, 'Argument "$')}`)
}
