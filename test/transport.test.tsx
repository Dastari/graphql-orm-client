// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react"
import type { Client as GraphQLWsClient } from "graphql-ws"
import { describe, expect, it } from "vitest"
import { createClient, type OperationRequest } from "../src/client.js"
import { encodeNodeId } from "../src/node-id.js"
import { ClientProvider, useFragment, useMutation } from "../src/react/index.js"
import { HttpError, createHttpNetwork, graphqlWsSubscribe, type GraphQLWsClientLike } from "../src/transport.js"
import { device, frags, mockNetwork, ops } from "./fixtures.js"

const request: OperationRequest = { kind: "query", name: "DevicePage", text: "query DevicePage { x }", hash: "h", variables: { Id: "d1" } }

function fakeFetch(status: number, body: string) {
  const calls: { url: string; init: RequestInit }[] = []
  const fetch = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init! })
    return new Response(body, { status, headers: { "content-type": "application/graphql-response+json" } })
  }
  return { fetch: fetch as typeof globalThis.fetch, calls }
}

describe("createHttpNetwork", () => {
  it("posts the operation with the caller's headers", async () => {
    const { fetch, calls } = fakeFetch(200, JSON.stringify({ data: { x: 1 } }))
    const network = createHttpNetwork({ url: "/graphql", fetch, headers: async () => ({ authorization: "Bearer t" }) })
    const controller = new AbortController()
    expect(await network.execute(request, { signal: controller.signal })).toEqual({ data: { x: 1 } })
    const [call] = calls
    expect(call!.url).toBe("/graphql")
    expect(call!.init.method).toBe("POST")
    expect(call!.init.signal).toBe(controller.signal)
    const headers = new Headers(call!.init.headers)
    expect(headers.get("authorization")).toBe("Bearer t")
    expect(headers.get("content-type")).toBe("application/json")
    expect(JSON.parse(String(call!.init.body))).toEqual({
      operationName: "DevicePage",
      query: "query DevicePage { x }",
      variables: { Id: "d1" },
    })
  })

  it("returns GraphQL errors whatever the status, and throws HttpError without them", async () => {
    const denied = { errors: [{ message: "denied", extensions: { code: "UNAUTHENTICATED" } }] }
    expect(await createHttpNetwork({ url: "/g", fetch: fakeFetch(401, JSON.stringify(denied)).fetch }).execute(request, {})).toEqual(denied)
    await expect(createHttpNetwork({ url: "/g", fetch: fakeFetch(502, "<html>bad gateway</html>").fetch }).execute(request, {})).rejects.toEqual(
      new HttpError(502)
    )
    await expect(createHttpNetwork({ url: "/g", fetch: fakeFetch(403, "{}").fetch }).execute(request, {})).rejects.toBeInstanceOf(HttpError)
  })
})

describe("graphqlWsSubscribe", () => {
  it("accepts a graphql-ws client and forwards its events", () => {
    // Type check: a real graphql-ws Client satisfies GraphQLWsClientLike.
    const adapt = (ws: GraphQLWsClient) => graphqlWsSubscribe(ws)
    expect(adapt).toBeTypeOf("function")
    let disposed = false
    const received: unknown[] = []
    let sent: unknown
    const ws: GraphQLWsClientLike = {
      subscribe(payload, sink) {
        sent = payload
        sink.next({ data: { DeviceChanged: null } })
        sink.complete()
        return () => {
          disposed = true
        }
      },
    }
    const dispose = graphqlWsSubscribe(ws)({ ...request, kind: "subscription" }, {
      next: (value) => received.push(value),
      error: () => received.push("error"),
      complete: () => received.push("complete"),
    })
    expect(sent).toEqual({ operationName: "DevicePage", query: "query DevicePage { x }", variables: { Id: "d1" } })
    expect(received).toEqual([{ data: { DeviceChanged: null } }, "complete"])
    dispose()
    expect(disposed).toBe(true)
  })
})

describe("useMutation", () => {
  it("commits, updates the store and reports failures", async () => {
    let fail = false
    const { network } = mockNetwork(({ name, variables }) => {
      if (name === "DevicePage") return { data: { Device: device("d1") } }
      if (fail) throw new Error("offline")
      return { data: { UpdateDevice: { __typename: "DeviceResult", Success: true, Entity: device("d1", { Name: variables.Name }) } } }
    })
    const client = createClient({ network })
    const { snapshot } = await client.execute<{ Device: object }>(ops.DevicePage, { Id: "d1" })
    const ref = snapshot.data.Device
    function Rename() {
      const { Name } = useFragment<{ Name: string }>(frags.DeviceRow, ref)
      const { commit, inFlight, error } = useMutation(ops.RenameDevice)
      return (
        <button onClick={() => void commit({ Id: "d1", Name: "renamed" }).catch(() => {})}>
          {`${Name} ${inFlight ? "saving" : "idle"} ${error?.message ?? "ok"}`}
        </button>
      )
    }
    render(
      <ClientProvider client={client}>
        <Rename />
      </ClientProvider>
    )
    expect(screen.getByRole("button").textContent).toBe("device-d1 idle ok")
    await act(async () => {
      fireEvent.click(screen.getByRole("button"))
    })
    expect(await screen.findByText("renamed idle ok")).toBeTruthy()
    expect(client.store.get(encodeNodeId("Device", ["d1"]))?.fields.get("Name")).toBe("renamed")
    fail = true
    await act(async () => {
      fireEvent.click(screen.getByRole("button"))
    })
    expect(await screen.findByText("renamed idle offline")).toBeTruthy()
  })
})
