import { createRequire } from "node:module"
import { join } from "node:path"
import type * as TypeScript from "typescript"

export interface ExtractOptions {
  /**
   * The file the code came from. Its extension picks how TypeScript parses it (`.tsx` and `.jsx` allow JSX), and
   * warnings name it.
   */
  readonly fileName?: string
  /** Gets a warning when a call is kept because its place couldn't be told. Default `console.warn`. */
  readonly onWarning?: (message: string) => void
  /**
   * The `typescript` module to place calls with. By default it's loaded if it can be: from this package, then from
   * the current directory. `null` skips it, so every call found is extracted, comments and strings included.
   */
  readonly typescript?: typeof TypeScript | null
}

let loaded: typeof TypeScript | null | undefined

/** The `typescript` package, when one can be found; it's optional. */
function loadTypeScript(): typeof TypeScript | null {
  if (loaded !== undefined) return loaded
  loaded = null
  for (const base of [import.meta.url, join(process.cwd(), "package.json")]) {
    try {
      const module = createRequire(base)("typescript") as typeof TypeScript
      if (typeof module.createSourceFile === "function" && typeof module.SyntaxKind === "object") return (loaded = module)
    } catch {
      // Not installed there.
    }
  }
  return loaded
}

type Place = "code" | "comment" | "string" | "unknown"

/** Where `position` falls in the parsed file: in code, a comment, a string-like token, or somewhere it can't say. */
function placeOf(ts: typeof TypeScript, file: TypeScript.SourceFile, position: number, functionName: string): Place {
  const literal = new Set<TypeScript.SyntaxKind>([
    ts.SyntaxKind.StringLiteral, ts.SyntaxKind.NoSubstitutionTemplateLiteral, ts.SyntaxKind.TemplateHead,
    ts.SyntaxKind.TemplateMiddle, ts.SyntaxKind.TemplateTail, ts.SyntaxKind.RegularExpressionLiteral,
    ts.SyntaxKind.JsxText, ts.SyntaxKind.JsxTextAllWhiteSpaces,
  ])
  let node: TypeScript.Node = file
  for (;;) {
    const child: TypeScript.Node | undefined = node.getChildren(file).find((candidate) => candidate.getFullStart() <= position && position < candidate.end)
    if (!child) return "unknown"
    if (child.kind >= ts.SyntaxKind.FirstJSDocNode && child.kind <= ts.SyntaxKind.LastJSDocNode) return "comment"
    // Between a token's full start and its start is trivia: whitespace and comments. A name isn't whitespace.
    if (position < child.getStart(file)) return "comment"
    if (literal.has(child.kind)) return "string"
    if (child.kind === ts.SyntaxKind.Identifier) return (child as TypeScript.Identifier).text === functionName && child.getStart(file) === position ? "code" : "unknown"
    node = child
  }
}

function scriptKind(ts: typeof TypeScript, fileName: string | undefined): TypeScript.ScriptKind {
  const extension = /\.[^./\\]+$/.exec(fileName ?? "")?.[0]?.toLowerCase()
  if (extension === ".tsx") return ts.ScriptKind.TSX
  if (extension === ".jsx") return ts.ScriptKind.JSX
  if (extension === ".js" || extension === ".mjs" || extension === ".cjs") return ts.ScriptKind.JS
  return ts.ScriptKind.TS
}

/**
 * Find the GraphQL documents in source code: the template literal or string passed to each
 * `graphql(...)` call. Templates with `${...}` interpolation are rejected, because the generated
 * `graphql()` maps each exact document text to its artifact.
 *
 * Every `graphql(` followed by a quote is a candidate. When the `typescript` package can be loaded, the file is
 * parsed with it (JSX for `.tsx` and `.jsx`), and a candidate inside a comment, or inside the text of another
 * string, template or regular expression, is skipped. Nothing else is dropped: a candidate whose place the parse
 * can't tell is kept with a warning, and a file TypeScript can't parse, or a project without TypeScript, keeps
 * every candidate, as earlier versions did.
 */
export function extractDocuments(code: string, functionName = "graphql", options: ExtractOptions = {}): string[] {
  const documents: string[] = []
  const pattern = new RegExp(`\\b${functionName}\\(\\s*([\`"'])`, "g")
  const ts = options.typescript === undefined ? (pattern.test(code) ? loadTypeScript() : null) : options.typescript
  pattern.lastIndex = 0
  const warn = options.onWarning ?? console.warn
  const where = options.fileName ?? "<document>"
  let file: TypeScript.SourceFile | null = null
  if (ts) {
    file = ts.createSourceFile(options.fileName ?? "document.ts", code, ts.ScriptTarget.Latest, true, scriptKind(ts, options.fileName))
    // An internal field, read with care: a file with syntax errors may be parsed wrongly, so trust none of it.
    const errors = (file as unknown as { parseDiagnostics?: readonly unknown[] }).parseDiagnostics
    if (errors?.length) {
      file = null
      if (pattern.test(code)) warn(`${where}: TypeScript couldn't parse this file, so ${functionName}() calls in its comments and strings are extracted too`)
      pattern.lastIndex = 0
    }
  }
  let match: RegExpExecArray | null
  while ((match = pattern.exec(code))) {
    if (ts && file) {
      const place = placeOf(ts, file, match.index, functionName)
      if (place === "comment" || place === "string") continue
      if (place === "unknown") {
        const line = code.slice(0, match.index).split("\n").length
        warn(`${where}:${line}: couldn't tell whether this ${functionName}() call is code, a comment or a string, so it was extracted`)
      }
    }
    const quote = match[1]!
    let index = match.index + match[0].length
    let text = ""
    let closed = false
    while (index < code.length) {
      const char = code[index]!
      if (char === "\\") {
        const next = code[index + 1] ?? ""
        // Resolve escapes to the string the call receives at runtime.
        text += next === "n" ? "\n" : next === "t" ? "\t" : next
        index += 2
        continue
      }
      if (char === quote) {
        closed = true
        break
      }
      if (quote === "`" && char === "$" && code[index + 1] === "{")
        throw new Error(`${functionName}() documents cannot interpolate values: ${text.trim().slice(0, 80)}`)
      text += char
      index += 1
    }
    if (!closed) throw new Error(`Unterminated ${functionName}() document: ${text.trim().slice(0, 80)}`)
    documents.push(text)
    pattern.lastIndex = index + 1
  }
  return documents
}
