import { createServer, type Server, type ServerResponse } from "node:http"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { buildSchema } from "graphql"
import { compile } from "../src/compiler/index.js"
import { classifyError, createClient, createHttpNetwork, type OperationRequest } from "../src/index.js"

// A real HTTP server that sends its headers and part of a body, then stalls: the read deadline passes while the body is arriving.
let server: Server
let url = ""
const stalled = new Set<ServerResponse>()
let answers = 0

beforeAll(async () => {
  server = createServer((request, response) => {
    request.resume()
    request.on("end", () => {
      answers++
      if (request.headers["x-complete"] === "yes") {
        response.writeHead(200, { "content-type": "application/json" })
        response.end(JSON.stringify({ data: { Foos: [] } }))
        return
      }
      response.writeHead(200, { "content-type": "application/graphql-response+json" })
      response.write('{"data":{"Foos":[')
      stalled.add(response)
    })
  })
  // Ports 42000-42099 only; take the first free one.
  for (let port = 42000; port < 42100 && !url; port++) {
    url = await new Promise<string>((resolve) => {
      server.once("error", () => resolve(""))
      server.listen(port, "127.0.0.1", () => resolve(`http://127.0.0.1:${port}/graphql`))
    })
  }
  if (!url) throw new Error("No free port in 42000-42099")
})

afterAll(async () => {
  for (const response of stalled) response.destroy()
  await new Promise((resolve) => server.close(resolve))
})

const request: OperationRequest = { kind: "query", name: "Foos", text: "query Foos { Foos { Id } }", hash: "", variables: {} }

describe("a read deadline that passes while the body is arriving", () => {
  it.each([
    ["without a byte limit", {}],
    ["with a byte limit", { maxResponseBytes: 1_000_000 }],
  ])("is no response, classified network (%s)", async (_label, bounds) => {
    const network = createHttpNetwork({ url, reads: { deadlineMs: 150, ...bounds } })
    const error = await network.execute(request, {}).then(() => null, (thrown: unknown) => thrown)
    expect(error).not.toBeNull()
    expect(classifyError(error)!.kind).toBe("network")
  })

  it("the caller's own abort while the body arrives stays cancelled", async () => {
    const controller = new AbortController()
    const pending = createHttpNetwork({ url, reads: { deadlineMs: 5_000 } }).execute(request, { signal: controller.signal }).then(() => null, (thrown: unknown) => thrown)
    setTimeout(() => controller.abort(), 100)
    expect(classifyError(await pending)!.kind).toBe("cancelled")
  })

  it("a watched query with retry reads again and ends ready", async () => {
    const compiled = compile(buildSchema("type Query { Foos: [Foo!]! } type Foo { Id: ID! }"), ["query Foos { Foos { Id } }"])
    let attempt = 0
    const network = createHttpNetwork({ url, reads: { deadlineMs: 150 }, headers: () => ({ "x-complete": attempt++ > 0 ? "yes" : "no" }) })
    const client = createClient({ network, reads: { retry: { baseMs: 10, random: () => 0 } } })
    const watched = client.watchQuery<any>(compiled.operations.Foos!, {})
    const before = answers
    watched.open()
    await expect.poll(() => watched.getState().status, { timeout: 3_000 }).toBe("ready")
    expect(answers - before).toBe(2)
    client.dispose()
  })
})
