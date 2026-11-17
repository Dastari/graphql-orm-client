// @vitest-environment jsdom
import { Component, StrictMode, Suspense, startTransition, useState, type ReactNode } from "react"
import { act, cleanup, render, screen } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { createClient, type Client, type LoadedQuery } from "../src/client.js"
import { ClientProvider, useSuspenseLoadedQuery } from "../src/react/index.js"
import { ops, widget, catalog, mockNetwork } from "./fixtures.js"

afterEach(() => { cleanup(); vi.useRealTimers() })

const deferred = () => {
  let resolve!: (value: any) => void, reject!: (error: unknown) => void
  const promise = new Promise<any>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

type Catalog = { Widgets: { Edges: readonly unknown[] } }
const renders: string[] = []
function Route({ loaded, label = "rows" }: { loaded: LoadedQuery<Catalog>; label?: string }) {
  const state = useSuspenseLoadedQuery(loaded)
  renders.push(`${label}:${state.status}`)
  return <p>{label} {state.data.Widgets.Edges.length} {state.status}{state.error ? ` failed: ${state.error.message}` : ""}</p>
}

class Boundary extends Component<{ children: ReactNode; onReset?: () => Promise<void> }, { error: Error | null }> {
  override state: { error: Error | null } = { error: null }
  static getDerivedStateFromError(error: Error) { return { error } }
  override render() {
    if (!this.state.error) return this.props.children
    return <button onClick={async () => { await this.props.onReset?.(); this.setState({ error: null }) }}>error: {this.state.error.message}</button>
  }
}

function app(client: Client, children: ReactNode, onReset?: () => Promise<void>) {
  return (
    <StrictMode>
      <ClientProvider client={client}>
        <Boundary onReset={onReset}>
          <Suspense fallback={<p>fallback</p>}>{children}</Suspense>
        </Boundary>
      </ClientProvider>
    </StrictMode>
  )
}

/** `use` needs an awaited act: React waits on the promise inside it. */
async function show(ui: ReactNode) {
  let view!: ReturnType<typeof render>
  await act(async () => { view = render(ui) })
  return { ...view, rerender: (next: ReactNode) => act(async () => view.rerender(next)) }
}

const retainedCount = (client: Client) => [...(client.store as any).retained.values()].reduce((sum: number, entry: { count: number }) => sum + entry.count, 0)
const resourceOf = (client: Client) => [...(client as any).resources.values()][0] as { listeners: Set<unknown>; users: number }

it("shows the fallback, then the data, with the loader's single request under StrictMode", async () => {
  const pending = deferred()
  const { network, requests } = mockNetwork(() => pending.promise)
  const client = createClient({ network })
  const loaded = client.loadQuery(ops.CatalogPage, {}) as LoadedQuery<Catalog>
  expect(requests).toHaveLength(1)
  const view = await show(app(client, <><Route loaded={loaded}/><Route loaded={loaded} label="again"/></>))
  expect(screen.getByText("fallback")).toBeTruthy()
  expect(requests).toHaveLength(1)
  // Rendering while suspended adds nothing to the read: one waiter, the loader's one use.
  expect(resourceOf(client).users).toBe(1)
  expect(resourceOf(client).listeners.size).toBe(1)
  await act(async () => { pending.resolve({ data: catalog([widget("w1"), widget("w2")]) }); await loaded.ready })
  expect(screen.getByText("rows 2 ready")).toBeTruthy()
  expect(screen.getByText("again 2 ready")).toBeTruthy()
  expect(requests).toHaveLength(1)
  view.unmount(); await act(async () => {})
  loaded.dispose()
  expect(retainedCount(client)).toBe(0)
  client.dispose()
})

it("renders at once, without a fallback, when the store already has the data", async () => {
  const { network, requests } = mockNetwork(() => ({ data: catalog([widget("w1")]) }))
  const client = createClient({ network })
  await client.loadQuery(ops.CatalogPage, {}).ready
  const loaded = client.loadQuery(ops.CatalogPage, {}) as LoadedQuery<Catalog>
  renders.length = 0
  await show(app(client, <Route loaded={loaded}/>))
  expect(screen.getByText("rows 1 ready")).toBeTruthy()
  expect(requests).toHaveLength(1)
  client.dispose()
})

it("sends a first-read error to the error boundary, and reads again after a refetch the boundary awaits", async () => {
  let fail = true
  const { network, requests } = mockNetwork(() => {
    if (fail) return Promise.reject(new Error("unreachable"))
    return { data: catalog([widget("w1")]) }
  })
  const client = createClient({ network })
  const loaded = client.loadQuery(ops.CatalogPage, {}) as LoadedQuery<Catalog>
  const quiet = vi.spyOn(console, "error").mockImplementation(() => {})
  await show(app(client, <Route loaded={loaded}/>, async () => { fail = false; await loaded.refetch() }))
  await act(async () => { await loaded.ready })
  expect(screen.getByText("error: unreachable")).toBeTruthy()
  await act(async () => { screen.getByRole("button").click() })
  await act(async () => {})
  expect(screen.getByText("rows 1 ready")).toBeTruthy()
  expect(requests).toHaveLength(2)
  quiet.mockRestore()
  client.dispose()
})

it("keeps showing data through a refetch and a failed refetch; the failure is in the state, not thrown", async () => {
  let answer: () => Promise<any> | any = () => ({ data: catalog([widget("w1")]) })
  const { network } = mockNetwork(() => answer())
  const client = createClient({ network })
  const loaded = client.loadQuery(ops.CatalogPage, {}) as LoadedQuery<Catalog>
  await loaded.ready
  await show(app(client, <Route loaded={loaded}/>))
  expect(screen.getByText("rows 1 ready")).toBeTruthy()
  const slow = deferred()
  answer = () => slow.promise
  let refetched!: Promise<void>
  act(() => { refetched = loaded.refetch() })
  expect(screen.getByText("rows 1 refreshing")).toBeTruthy()
  expect(screen.queryByText("fallback")).toBeNull()
  await act(async () => { slow.resolve({ data: catalog([widget("w1"), widget("w2")]) }); await refetched })
  expect(screen.getByText("rows 2 ready")).toBeTruthy()
  answer = () => Promise.reject(new Error("offline"))
  await act(async () => { await loaded.refetch() })
  expect(screen.getByText("rows 2 error failed: offline")).toBeTruthy()
  client.dispose()
})

it("suspends again for a new handle, and keeps the previous data when the new handle arrives in a transition", async () => {
  const answers: ReturnType<typeof deferred>[] = []
  const { network } = mockNetwork(() => { const next = deferred(); answers.push(next); return next.promise })
  const client = createClient({ network })
  const first = client.loadQuery(ops.CatalogPage, {}) as LoadedQuery<Catalog>
  let select!: (loaded: LoadedQuery<Catalog>, transition: boolean) => void
  function Switcher() {
    const [loaded, setLoaded] = useState(first)
    select = (next, transition) => (transition ? startTransition(() => setLoaded(next)) : setLoaded(next))
    return <Route loaded={loaded}/>
  }
  await show(app(client, <Switcher/>))
  await act(async () => { answers[0]!.resolve({ data: catalog([widget("w1")]) }); await first.ready })
  expect(screen.getByText("rows 1 ready")).toBeTruthy()

  const second = client.loadQuery(ops.CatalogPage, { Where: { Name: { eq: "b" } } } as any) as LoadedQuery<Catalog>
  await act(async () => select(second, true))
  // In a transition React keeps the committed screen until the new handle has data.
  expect(screen.getByText("rows 1 ready")).toBeTruthy()
  expect(screen.queryByText("fallback")).toBeNull()
  await act(async () => { answers[1]!.resolve({ data: catalog([widget("w2"), widget("w3")]) }); await second.ready })
  expect(screen.getByText("rows 2 ready")).toBeTruthy()

  const third = client.loadQuery(ops.CatalogPage, { Where: { Name: { eq: "c" } } } as any) as LoadedQuery<Catalog>
  await act(async () => select(third, false))
  // Outside a transition the nearest boundary shows its fallback.
  expect(screen.getByText("fallback")).toBeTruthy()
  await act(async () => { answers[2]!.resolve({ data: catalog([]) }); await third.ready })
  expect(screen.getByText("rows 0 ready")).toBeTruthy()
  client.dispose()
})

it("disposing the client while suspended releases the read and never renders it under the next identity", async () => {
  const pendingA = deferred(), pendingB = deferred()
  const a = mockNetwork(() => pendingA.promise), b = mockNetwork(() => pendingB.promise)
  const clientA = createClient({ network: a.network }), clientB = createClient({ network: b.network })
  const loadedA = clientA.loadQuery(ops.CatalogPage, {}) as LoadedQuery<Catalog>
  const view = await show(app(clientA, <Route loaded={loadedA} label="a"/>))
  expect(screen.getByText("fallback")).toBeTruthy()
  const resourceA = resourceOf(clientA)
  expect(resourceA.listeners.size).toBe(1)
  renders.length = 0

  await act(async () => { clientA.dispose(); await loadedA.ready })
  // The waiter is gone, the read is closed and the store holds nothing.
  expect(resourceA.listeners.size).toBe(0)
  expect(resourceA.users).toBe(0)
  expect(retainedCount(clientA)).toBe(0)
  expect(clientA.store.size).toBe(0)
  // The identity ended: the tree keeps its fallback rather than showing an error or an old result.
  expect(screen.getByText("fallback")).toBeTruthy()

  // The next identity renders, with the old handle still in props until its loader runs again.
  await view.rerender(app(clientB, <Route loaded={loadedA} label="a"/>))
  await act(async () => { pendingA.resolve({ data: catalog([widget("w1")]) }); await Promise.resolve() })
  expect(screen.getByText("fallback")).toBeTruthy()
  expect(screen.queryByText(/^error/)).toBeNull()

  const loadedB = clientB.loadQuery(ops.CatalogPage, {}) as LoadedQuery<Catalog>
  await view.rerender(app(clientB, <Route loaded={loadedB} label="b"/>))
  await act(async () => { pendingB.resolve({ data: catalog([widget("w9"), widget("w8")]) }); await loadedB.ready })
  expect(screen.getByText("b 2 ready")).toBeTruthy()
  expect(renders.some((entry) => entry.startsWith("a:"))).toBe(false)
  expect(resourceA.listeners.size).toBe(0)
  clientB.dispose()
})

it("a handle from another live client is an error, as with useLoadedQuery", async () => {
  const { network } = mockNetwork(() => ({ data: catalog([]) }))
  const one = createClient({ network }), other = createClient({ network })
  const loaded = one.loadQuery(ops.CatalogPage, {}) as LoadedQuery<Catalog>
  await loaded.ready
  const quiet = vi.spyOn(console, "error").mockImplementation(() => {})
  await show(app(other, <Route loaded={loaded}/>))
  expect(screen.getByText(/different identity client/)).toBeTruthy()
  quiet.mockRestore()
  one.dispose(); other.dispose()
})

it("an aborted load reaches the error boundary instead of waiting forever", async () => {
  const pending = deferred(), abort = new AbortController()
  const { network } = mockNetwork(() => pending.promise)
  const client = createClient({ network })
  const loaded = client.loadQuery(ops.CatalogPage, {}, { signal: abort.signal }) as LoadedQuery<Catalog>
  const quiet = vi.spyOn(console, "error").mockImplementation(() => {})
  await show(app(client, <Route loaded={loaded}/>))
  expect(resourceOf(client).listeners.size).toBe(1)
  const resource = resourceOf(client)
  await act(async () => { abort.abort(); await loaded.ready })
  expect(screen.getByText(/route load was disposed/)).toBeTruthy()
  expect(resource.listeners.size).toBe(0)
  quiet.mockRestore()
  client.dispose()
})

it("the unused-load deadline waits for a read a suspended render is waiting on, then runs again if nothing mounts", async () => {
  vi.useFakeTimers()
  const pending = deferred()
  const { network, requests } = mockNetwork(() => pending.promise)
  const client = createClient({ network })
  const loaded = client.loadQuery(ops.CatalogPage, {}, { timeoutMs: 10 }) as LoadedQuery<Catalog>
  const resource = resourceOf(client)
  // What the hook does while it suspends: wait on the handle.
  const waiting = loaded.suspend()
  expect(loaded.suspend()).toBe(waiting)
  await vi.advanceTimersByTimeAsync(50)
  expect(resource.users).toBe(1)
  pending.resolve({ data: catalog([widget("w1")]) })
  await waiting
  expect(loaded.getState().status).toBe("ready")
  expect(requests).toHaveLength(1)
  // The suspended render was abandoned: nothing mounted, so the load closes after its deadline.
  await vi.advanceTimersByTimeAsync(10)
  expect(resource.users).toBe(0)
  expect(resource.listeners.size).toBe(0)
  client.dispose()
})

it("a suspended render opens an expired load again", async () => {
  vi.useFakeTimers()
  const answers: ReturnType<typeof deferred>[] = []
  const { network, requests } = mockNetwork(() => { const next = deferred(); answers.push(next); return next.promise })
  const client = createClient({ network })
  const loaded = client.loadQuery(ops.CatalogPage, {}, { timeoutMs: 10 }) as LoadedQuery<Catalog>
  // The route's code took longer than the deadline: the unused load closed and dropped its read.
  await vi.advanceTimersByTimeAsync(10)
  expect(resourceOf(client)).toBeUndefined()
  const waiting = loaded.suspend()
  expect(requests).toHaveLength(2)
  answers[1]!.resolve({ data: catalog([widget("w1")]) })
  await waiting
  expect(loaded.getState().status).toBe("ready")
  client.dispose()
  expect(() => loaded.suspend()).toThrow(/disposed/)
})
