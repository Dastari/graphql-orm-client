/**
 * Find the GraphQL documents in source code: the template literal or string passed to each
 * `graphql(...)` call. Templates with `${...}` interpolation are rejected, because the generated
 * `graphql()` maps each exact document text to its artifact.
 */
export function extractDocuments(code: string, functionName = "graphql"): string[] {
  const documents: string[] = []
  const pattern = new RegExp(`\\b${functionName}\\(\\s*([\`"'])`, "g")
  let match: RegExpExecArray | null
  while ((match = pattern.exec(code))) {
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
