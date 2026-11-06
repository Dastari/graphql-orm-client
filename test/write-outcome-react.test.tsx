// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react"
import { expect, it } from "vitest"
import { createClient } from "../src/client.js"
import { ClientProvider, useMutation } from "../src/react/index.js"
import { mockNetwork, ops } from "./fixtures.js"

it("step-up retry is explicit and uses fresh variables, with no replay", async () => {
  let admitted = false
  const { network, requests } = mockNetwork(() => admitted
    ? { data: { UpdateWidget: { Success: true } } }
    : { data: null, errors: [{ message: "step up", extensions: { outcome: "refused" } }] })
  const client = createClient({ network })
  const { result, unmount } = renderHook(() => useMutation(ops.RenameWidget!), {
    wrapper: ({ children }) => <ClientProvider client={client}>{children}</ClientProvider>,
  })
  await act(async () => {
    expect((await result.current.commitOutcome({ Id: "w1", Name: "first" })).outcome.status).toBe("refused")
  })
  admitted = true // Authentication happens outside the hook; it receives no credential.
  expect(requests).toHaveLength(1)
  await act(async () => {
    expect((await result.current.commitOutcome({ Id: "w1", Name: "fresh" })).outcome.status).toBe("confirmed")
  })
  expect(requests.map(r => r.variables.Name)).toEqual(["first", "fresh"])
  expect(result.current.inFlight).toBe(false)
  unmount()
  client.dispose()
})
