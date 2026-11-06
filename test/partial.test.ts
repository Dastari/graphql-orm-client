import { expect, it } from "vitest"
import { compile } from "../src/compiler/index.js"
import { createClient, readFragment } from "../src/client.js"
import { errorsAtPath } from "../src/partial.js"
import { schema, mockNetwork } from "./fixtures.js"

const { operations, fragments } = compile(schema, [
  'query Dashboard { bad: Widget(Id: "w1") { ...Row } good: LookupName(Text: "good") }',
  'query Other { Widget(Id: "w1") { ...Row } }',
  'fragment Row on Widget { Name RowVersion }',
], { versions: { Widget: 'RowVersion' } })
const good = { __typename: "Widget", Id: "w1", Name: "retained", RowVersion: 4 }
const errors = [{ message: "refused", path: ["bad", "Name"] }]
it.each(["legacy", "preserve-errors"] as const)("actual partial response keeps successful alias (%s)", async partialResults => {
  let next: any = { data: { bad: good, good: "count" } }
  const client = createClient({ network: mockNetwork(() => next).network, partialResults })
  await client.query(operations.Dashboard!, {}, { policy: "network-only" })
  next = { data: { bad: null, good: "new-count" }, errors }
  const result = await client.query<any>(operations.Dashboard!, {}, { policy: "network-only" })
  expect(result.data.good).toBe("new-count")
  expect(result.errors).toEqual(errors)
  expect(errorsAtPath(result.errors, ["bad"])).toEqual(errors)
  expect(errorsAtPath(result.errors, ["good"])).toEqual([])
  if (partialResults === "legacy") expect(result.data.bad).toBeNull()
  else expect(readFragment<any>(fragments.Row!, result.data.bad).Name).toBe("retained")
})

it("preserves refused nested scalar, allows successful null and version ordering across holders", async () => {
  let next: any = { data: { bad: good, good: "count" } }
  const client = createClient({ network: mockNetwork(() => next).network, partialResults: "preserve-errors" })
  const first = await client.query<any>(operations.Dashboard!, {})
  next = { data: { Widget: { ...good, Name: "newer", RowVersion: 5 } } }
  await client.query(operations.Other!, {}, { policy: "network-only" })
  next = { data: { bad: { ...good, Name: null, RowVersion: 6 }, good: "ok" }, errors }
  await client.query(operations.Dashboard!, {}, { policy: "network-only" })
  expect(readFragment<any>(fragments.Row!, first.data.bad).Name).toBe("newer")
  next = { data: { bad: { ...good, Name: "older", RowVersion: 4 }, good: null } }
  const older = await client.query<any>(operations.Dashboard!, {}, { policy: "network-only" })
  expect(readFragment<any>(fragments.Row!, first.data.bad).Name).toBe("newer")
  expect(older.data.good).toBeNull()
  client.store.collect()
  client.dispose()
  await expect(client.query(operations.Dashboard!, {}, { policy: "network-only" })).rejects.toThrow()
})

it("watched queries expose partial data and per-path errors without throwing", async () => {
  const client = createClient({ partialResults: "preserve-errors", network: mockNetwork(() => ({ data: { bad: null, good: "ok" }, errors })).network })
  const watch = client.watchQuery<any>(operations.Dashboard!, {})
  watch.open()
  await watch.refetch()
  expect(watch.getState().status).toBe("ready")
  expect(watch.getState().data.good).toBe("ok")
  expect(watch.getState().errors).toEqual(errors)
  watch.close()
  client.dispose()
})

it("a refused array position preserves the whole list rather than guessing list identity", async () => {
  const { withoutErrorNulls } = await import("../src/partial.js")
  expect(withoutErrorNulls({ rows: [{ Name: "ok" }, null], count: 2 }, [{ message: "denied", path: ["rows", 1, "Name"] }]))
    .toEqual({ count: 2 })
  expect(withoutErrorNulls({ rows: [null], count: null }, [])).toEqual({ rows: [null], count: null })
})
