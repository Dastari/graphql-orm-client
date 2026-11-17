/**
 * Printing that gives the same text with graphql 16 and 17. Operation text is hashed and compared by `generate --check`,
 * and a schema snapshot is hashed for drift and persistence, so a project's output must not change with the graphql
 * version it installs. graphql 17 prints object values as `{ a: 1 }` where 16 prints `{a: 1}`, and prints a schema
 * default as written where 16 prints the coerced value, with the input fields' own defaults filled in. Both are
 * printed here as graphql 16 prints them, so nothing changes for a project that stays on 16.
 */
import {
  Kind,
  astFromValue,
  isInputObjectType,
  isInterfaceType,
  isObjectType,
  parse,
  print,
  printSchema,
  visit,
  type ASTNode,
  type ConstValueNode,
  type GraphQLArgument,
  type GraphQLInputField,
  type GraphQLInputType,
  type GraphQLSchema,
  type InputValueDefinitionNode,
  type ObjectValueNode,
  type ValueNode,
} from "graphql"
import * as graphql from "graphql"

/** `print`, with object values written as graphql 16 writes them, so line wrapping also matches. */
export function printStable(node: ASTNode): string {
  return print(visit(node, {
    // An enum value prints verbatim, so it carries the finished text through the rest of the printer.
    ObjectValue: { leave: (value: ObjectValueNode) => ({ kind: Kind.ENUM, value: `{${value.fields.map((field) => `${field.name.value}: ${print(field.value)}`).join(", ")}}` }) },
  }))
}

/** `printSchema`, with each argument and input field default printed as graphql 16 prints it. */
export function printSchemaStable(schema: GraphQLSchema): string {
  const text = printSchema(schema)
  const edits: { start: number; end: number; text: string }[] = []
  const definitions = parse(text).definitions
  for (const definition of definitions) {
    const inputs: [InputValueDefinitionNode, GraphQLArgument | GraphQLInputField | undefined][] = []
    if (definition.kind === Kind.DIRECTIVE_DEFINITION) {
      const directive = schema.getDirective(definition.name.value)
      for (const node of definition.arguments ?? []) inputs.push([node, directive?.args.find((arg) => arg.name === node.name.value)])
    } else if (definition.kind === Kind.OBJECT_TYPE_DEFINITION || definition.kind === Kind.INTERFACE_TYPE_DEFINITION) {
      const type = schema.getType(definition.name.value)
      const fields = isObjectType(type) || isInterfaceType(type) ? type.getFields() : {}
      for (const field of definition.fields ?? [])
        for (const node of field.arguments ?? []) inputs.push([node, fields[field.name.value]?.args.find((arg) => arg.name === node.name.value)])
    } else if (definition.kind === Kind.INPUT_OBJECT_TYPE_DEFINITION) {
      const type = schema.getType(definition.name.value)
      const fields = isInputObjectType(type) ? type.getFields() : {}
      for (const node of definition.fields ?? []) inputs.push([node, fields[node.name.value]])
    }
    for (const [node, input] of inputs) {
      if (!node.defaultValue?.loc || !node.type.loc || !input) continue
      const value = defaultValueOf(input)
      const literal = value === undefined ? null : astFromValue(value, input.type)
      // graphql 16 leaves out a default it can't coerce.
      if (!literal) edits.push({ start: node.type.loc.end, end: node.defaultValue.loc.end, text: "" })
      else edits.push({ start: node.defaultValue.loc.start, end: node.defaultValue.loc.end, text: printStable(literal) })
    }
  }
  let result = text
  for (const edit of edits.sort((a, b) => b.start - a.start)) result = result.slice(0, edit.start) + edit.text + result.slice(edit.end)
  return result
}

/** The coerced default: graphql 16 keeps it in `defaultValue`; graphql 17 keeps the literal or external value in `default`. */
function defaultValueOf(input: GraphQLArgument | GraphQLInputField): unknown {
  if (input.defaultValue !== undefined) return input.defaultValue
  const modern = (input as { default?: { literal?: ConstValueNode; value?: unknown } }).default
  if (!modern) return undefined
  // graphql 17 only. Its `valueFromAST` doesn't fill in input fields' own defaults, and `coerceInputLiteral` does.
  const coerce = graphql as unknown as {
    coerceInputLiteral: (node: ValueNode, type: GraphQLInputType) => unknown
    coerceInputValue: (value: unknown, type: GraphQLInputType) => unknown
  }
  return modern.literal ? coerce.coerceInputLiteral(modern.literal, input.type) : coerce.coerceInputValue(modern.value, input.type)
}
