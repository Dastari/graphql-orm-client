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
  isAbstractType,
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

/** One argument a fragment declares, at one spread of it. */
export interface SpreadArgument {
  readonly name: string
  /** What the spread passes with `@arguments`, in the spreading scope's terms. */
  readonly passed?: ValueNode
  readonly defaultValue?: ConstValueNode
}

/** Each argument a fragment declares, at one spread of it. Undefined when the fragment declares none. */
export function spreadArguments(fragment: FragmentDefinitionNode, spread: FragmentSpreadNode): readonly SpreadArgument[] | undefined {
  const declared = declarations.get(fragment)
  if (!declared) return undefined
  const passed = new Map((argumentsDirective(spread)?.arguments ?? []).map((argument) => [argument.name.value, argument.value]))
  return declared.map((argument) => {
    const value = passed.get(argument.name)
    return { name: argument.name, ...(value ? { passed: value } : {}), ...(argument.defaultValue ? { defaultValue: argument.defaultValue } : {}) }
  })
}

/** The name a reader resolves a fragment's local argument under. It has a dot, so it can't be an operation variable's name. */
export function scopedName(fragment: string, argument: string): string {
  return `${fragment}.${argument}`
}

const NULL: ValueNode = { kind: Kind.NULL }

/** What a spread binds each argument to, as written: what it passes, else the default. An argument with neither is unbound. */
function bindingsOf(args: readonly SpreadArgument[]): Map<string, ValueNode> {
  return new Map(args.flatMap((argument) => {
    const value = argument.passed ?? argument.defaultValue
    return value ? [[argument.name, value] as const] : []
  }))
}

/** Possible concrete types of a named type, or null for any. */
function possibleTypesOf(schema: GraphQLSchema, name: string | undefined): ReadonlySet<string> | null {
  const type = name === undefined ? undefined : schema.getType(name)
  if (!type) return null
  return new Set(isAbstractType(type) ? schema.getPossibleTypes(type).map((entry) => entry.name) : [type.name])
}

function narrow(outer: ReadonlySet<string> | null, inner: ReadonlySet<string> | null): ReadonlySet<string> | null {
  if (!outer) return inner
  if (!inner) return outer
  return new Set([...outer].filter((name) => inner.has(name)))
}

function overlaps(a: ReadonlySet<string> | null, b: ReadonlySet<string> | null): boolean {
  if (!a || !b) return true
  for (const name of a) if (b.has(name)) return true
  return false
}

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
  // Each copy's name, with the fragment and values it was made for, so two argument sets never share one.
  const copies = new Map<string, string>()
  // The fragments being written out, outermost first. A fragment met again inside itself is a cycle.
  const expanding: string[] = []
  type Scope = { readonly bindings: ReadonlyMap<string, ValueNode>; readonly locals: ReadonlySet<string> }
  const rewrite = <T extends ASTNode>(node: T, scope: Scope | null): T =>
    visit(node, {
      // Substituting whole values, so a bound value's own variables, the operation's, are never substituted again. An argument
      // whose value is an unbound one of the fragment's is left out, as an unset variable would be.
      Argument(argument) {
        if (!scope) return undefined
        const value = substitute(argument.value, scope)
        return value ? { ...argument, value } : null
      },
      FragmentSpread: {
        leave(spread) {
          const definition = fragments.get(spread.name.value)
          const directives = spread.directives?.filter((directive) => directive.name.value !== "arguments")
          if (!definition) return { ...spread, directives }
          const args = spreadArguments(definition, spread)
          return { ...spread, directives, name: { kind: Kind.NAME, value: specialize(definition, args) } }
        },
      },
    }) as T
  const specialize = (definition: FragmentDefinitionNode, args: readonly SpreadArgument[] | undefined): string => {
    const name = definition.name.value
    const bindings = args ? bindingsOf(args) : null
    const key = bindings ? printStable({ kind: Kind.OBJECT, fields: [...bindings].map(([field, value]) => ({ kind: Kind.OBJECT_FIELD, name: { kind: Kind.NAME, value: field }, value })) }) : ""
    const copy = bindings ? `${name}_${createHash("sha256").update(`${name}${key}`).digest("hex").slice(0, 8)}` : name
    if (bindings) {
      if (fragments.has(copy)) {
        problems.push(`Fragment ${copy} has the name the compiler gives the copy of fragment ${name} for ${key}; rename it`)
        return copy
      }
      const made = copies.get(copy)
      if (made !== undefined && made !== `${name} ${key}`) {
        problems.push(`Fragment ${name}'s copies for ${key} and for ${made.slice(name.length + 1)} would both be named ${copy}; change one of the values`)
        return copy
      }
      copies.set(copy, `${name} ${key}`)
    }
    const at = expanding.indexOf(name)
    if (at >= 0) {
      problems.push(`Fragment ${name} spreads itself: ${[...expanding.slice(at), name].join(" → ")}`)
      return copy
    }
    if (wire.has(copy)) return copy
    expanding.push(name)
    const locals = new Set((declarations.get(definition) ?? []).map((argument) => argument.name))
    const body = rewrite(definition, bindings ? { bindings, locals } : null)
    expanding.pop()
    wire.set(copy, { ...body, name: { kind: Kind.NAME, value: copy }, directives: withoutArgumentDefinitions(body.directives) })
    return copy
  }
  for (const definition of fragments.values()) {
    if (!declarations.has(definition)) specialize(definition, undefined)
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
  return { operations: result, fragments: wire, problems: [...new Set(problems)] }
}

function withoutArgumentDefinitions(directives: readonly DirectiveNode[] | undefined): readonly DirectiveNode[] | undefined {
  return directives?.filter((directive) => directive.name.value !== "argumentDefinitions")
}

/**
 * A value with the fragment's arguments written in. An unbound argument is absent, as an unset variable is: undefined at
 * the top, so the caller leaves the argument out; an object field is left out; a list item, which can't be, is null.
 */
function substitute(value: ValueNode, scope: { readonly bindings: ReadonlyMap<string, ValueNode>; readonly locals: ReadonlySet<string> }): ValueNode | undefined {
  switch (value.kind) {
    case Kind.VARIABLE: {
      const name = value.name.value
      return scope.bindings.get(name) ?? (scope.locals.has(name) ? undefined : value)
    }
    case Kind.LIST:
      return { ...value, values: value.values.map((item) => substitute(item, scope) ?? NULL) }
    case Kind.OBJECT:
      return {
        ...value,
        fields: value.fields.flatMap((field) => {
          const inner = substitute(field.value, scope)
          return inner ? [{ ...field, value: inner }] : []
        }),
      }
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
  // `types`: the concrete types a spread can apply to, narrowed by type conditions; null for any. `path`: the same for each
  // object above, since fields of one response key merge into one object only where their parents can be one object.
  type Types = ReadonlySet<string> | null
  type Seen = { readonly name: string; readonly key: string; readonly types: Types; readonly path: readonly Types[] }
  type Part = { readonly set: SelectionSetNode; readonly path: readonly Types[] }
  const together = (a: readonly Types[], b: readonly Types[]) => a.every((types, index) => overlaps(types, b[index] ?? null))
  // GraphQL merges every field of one response key under an object into one field, and the reader builds one object for it,
  // so their selections are checked as one object.
  const onObject = (parts: readonly Part[]) => {
    const seen: Seen[] = []
    const children = new Map<string, Part[]>()
    const walk = (set: SelectionSetNode, types: Types, path: readonly Types[]) => {
      for (const selection of set.selections) {
        if (selection.kind === Kind.FIELD) {
          if (!selection.selectionSet) continue
          const key = selection.alias?.value ?? selection.name.value
          children.set(key, [...(children.get(key) ?? []), { set: selection.selectionSet, path: [...path, types] }])
        } else if (selection.kind === Kind.INLINE_FRAGMENT) {
          walk(selection.selectionSet, narrow(types, possibleTypesOf(schema, selection.typeCondition?.name.value)), path)
        } else {
          const name = selection.name.value
          const definition = fragments.get(name)
          if (!definition) continue
          checkSpread(schema, selection, definition, where, variableOf, problems)
          const args = spreadArguments(definition, selection)
          if (!args) continue
          const key = [...bindingsOf(args)].map(([argument, value]) => `${argument}: ${print(value)}`).join(", ")
          const applies = narrow(types, possibleTypesOf(schema, definition.typeCondition.name.value))
          // Spreads under type conditions that can't both match one object never meet.
          const earlier = seen.find((entry) => entry.name === name && entry.key !== key && overlaps(entry.types, applies) && together(entry.path, path))
          if (earlier)
            problems.push(`${where}: fragment ${name} is spread twice on one object with different arguments (${earlier.key}) and (${key}); spread each under its own alias`)
          seen.push({ name, key, types: applies, path })
        }
      }
    }
    for (const part of parts) walk(part.set, null, part.path)
    for (const group of children.values()) onObject(group)
  }
  onObject([{ set: selectionSet, path: [] }])
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
