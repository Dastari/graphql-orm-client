const IDENTIFIER = /[A-Za-z0-9_$]/
/** After one of these, a `/` starts a regular expression; after anything else it divides. */
const BEFORE_EXPRESSION = new Set([..."(,=:[!&|?{};+-*%<>~^"])
const KEYWORDS_BEFORE_EXPRESSION = new Set(["return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await"])

/**
 * Find the GraphQL documents in source code: the template literal or string passed to each
 * `graphql(...)` call. Templates with `${...}` interpolation are rejected, because the generated
 * `graphql()` maps each exact document text to its artifact.
 *
 * Only calls in code count. A call inside a line or block comment, or inside the text of another string or
 * template, is skipped; one inside a template's `${...}` is code, and counts. This is a scanner, not a parser:
 * a string that isn't closed by the end of its line is taken to end there, so a stray quote (an apostrophe in
 * JSX text, say) can hide a call on its own line but not on the next.
 */
export function extractDocuments(code: string, functionName = "graphql"): string[] {
  const documents: string[] = []
  const call = new RegExp(`${functionName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\(\\s*([\`"'])`, "y")
  // The brace depth at which each open `${` began; its matching `}` returns to the template's text.
  const templates: number[] = []
  let depth = 0
  // The last significant character of code, to tell a regular expression from a division.
  let last = -1

  /** Template text from `start`; returns where code resumes, after the closing backtick or after a `${`. */
  const templateText = (start: number): number => {
    let index = start
    while (index < code.length) {
      const char = code[index]!
      if (char === "\\") index += 2
      else if (char === "`") return index + 1
      else if (char === "$" && code[index + 1] === "{") {
        templates.push(depth)
        depth += 1
        return index + 2
      } else index += 1
    }
    return index
  }

  /** The end of a quoted string, or of its line when it isn't closed there. */
  const stringEnd = (start: number, quote: string): number => {
    let index = start + 1
    while (index < code.length) {
      const char = code[index]!
      if (char === "\\") index += 2
      else if (char === quote) return index + 1
      else if (char === "\n") return index
      else index += 1
    }
    return index
  }

  /** The end of a regular expression literal starting at `start`, or -1 when the line ends first. */
  const regexEnd = (start: number): number => {
    let index = start + 1
    let inClass = false
    while (index < code.length) {
      const char = code[index]!
      if (char === "\n") return -1
      if (char === "\\") index += 2
      else {
        if (char === "[") inClass = true
        else if (char === "]") inClass = false
        else if (char === "/" && !inClass) {
          index += 1
          while (index < code.length && IDENTIFIER.test(code[index]!)) index += 1
          return index
        }
        index += 1
      }
    }
    return -1
  }

  const startsExpression = (): boolean => {
    if (last < 0) return true
    const char = code[last]!
    if (BEFORE_EXPRESSION.has(char)) return true
    if (!IDENTIFIER.test(char)) return false
    const word = /[A-Za-z_$][A-Za-z0-9_$]*$/.exec(code.slice(Math.max(0, last - 15), last + 1))?.[0]
    return word !== undefined && KEYWORDS_BEFORE_EXPRESSION.has(word)
  }

  /** The document a call passes, from just after its opening quote; returns it and the index of the closing quote. */
  const readDocument = (start: number, quote: string): { text: string; end: number } => {
    let index = start
    let text = ""
    while (index < code.length) {
      const char = code[index]!
      if (char === "\\") {
        const next = code[index + 1] ?? ""
        // Resolve escapes to the string the call receives at runtime.
        text += next === "n" ? "\n" : next === "t" ? "\t" : next
        index += 2
        continue
      }
      if (char === quote) return { text, end: index }
      if (quote === "`" && char === "$" && code[index + 1] === "{")
        throw new Error(`${functionName}() documents cannot interpolate values: ${text.trim().slice(0, 80)}`)
      text += char
      index += 1
    }
    throw new Error(`Unterminated ${functionName}() document: ${text.trim().slice(0, 80)}`)
  }

  let index = 0
  while (index < code.length) {
    const char = code[index]!
    const next = code[index + 1]
    if (char === "/" && next === "/") {
      const end = code.indexOf("\n", index)
      index = end < 0 ? code.length : end
    } else if (char === "/" && next === "*") {
      const end = code.indexOf("*/", index + 2)
      index = end < 0 ? code.length : end + 2
    } else if (char === "/" && startsExpression() && regexEnd(index) >= 0) {
      index = regexEnd(index)
      last = index - 1
    } else if (char === '"' || char === "'") {
      index = stringEnd(index, char)
      last = index - 1
    } else if (char === "`") {
      index = templateText(index + 1)
      last = index - 1
    } else if (char === "{") {
      depth += 1
      last = index++
    } else if (char === "}") {
      depth -= 1
      if (templates.length && templates[templates.length - 1] === depth) {
        templates.pop()
        index = templateText(index + 1)
        last = index - 1
      } else last = index++
    } else if (IDENTIFIER.test(char)) {
      const word = /[A-Za-z0-9_$]+/y
      word.lastIndex = index
      word.exec(code)
      const wordEnd = word.lastIndex
      call.lastIndex = index
      const match = code.slice(index, wordEnd) === functionName ? call.exec(code) : null
      if (match) {
        const { text, end } = readDocument(call.lastIndex, match[1]!)
        documents.push(text)
        index = end + 1
      } else index = wordEnd
      last = index - 1
    } else {
      if (!/\s/.test(char)) last = index
      index += 1
    }
  }
  return documents
}
