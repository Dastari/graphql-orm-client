import { buildSchema } from "graphql"
import { compile } from "../src/compiler/index.js"
import type { GraphQLResponse, OperationRequest } from "../src/client.js"
import { createMockNetwork, createMockStreams, type MockNetwork, type MockStreams } from "../src/test/index.js"

/** A schema in graphql-orm's shape: PascalCase fields, Id keys, keyset connections, Where inputs. */
export const schema = buildSchema(`
  type Query {
    Widgets(Where: WidgetWhereInput, Page: KeysetPageInput): WidgetConnection!
    Widget(Id: String!): Widget
    Vendor(Id: String!): Vendor
    Slot(Site: String!, Name: String!): Slot
    Search(Text: String!): [SearchHit!]!
    Tickets(Where: TicketWhereInput, Page: PageInput): TicketConnection!
    LookupName(Text: String!): String
    TicketSummary(Queue: String!): TicketSummary
    ReportRows(Limit: Int!): [ReportRow!]!
  }
  type Mutation {
    UpdateWidget(Id: String!, Input: UpdateWidgetInput!): WidgetResult!
    ReopenTicket(Id: String!): ReopenResult!
    Ping: Boolean!
    IssueToken(Id: String!): TokenResult!
  }
  type Subscription {
    WidgetChanged(Filter: SubscriptionFilterInput, Key: String): WidgetChangedEvent!
    SlotChanged(Filter: SubscriptionFilterInput, Keys: [SlotKeyInput!]): SlotChangedEvent!
    VendorChanged(Filter: SubscriptionFilterInput): VendorChangedEvent!
    TicketChanged(Filter: SubscriptionFilterInput, Key: String, Keys: [String!]): TicketChangedEvent!
  }
  type TicketChangedEvent { Action: ChangeAction!, ChangeKind: ChangeKind!, Id: String!, Ticket: Ticket }
  input PageInput { Limit: Int, Offset: Int }
  input TicketWhereInput { State: StringFilter }
  type TicketConnection { Edges: [TicketEdge!]!, PageInfo: PageInfo! }
  type TicketEdge { Cursor: String!, Node: Ticket! }
  type Ticket { Id: String!, Title: String!, State: String!, RecordVersion: Int! }
  type TicketSummary { Open: Int!, Closed: Int!, Oldest: Ticket }
  type ReportRow { Label: String!, Count: Int! }
  type ReopenResult { Accepted: Boolean!, Message: String, Ticket: Ticket, Audit: [AuditEntry!]! }
  type AuditEntry { At: String!, By: String! }
  type TokenResult { Secret: String!, Ticket: Ticket, Audit: [AuditEntry!]! }
  input SubscriptionFilterInput { Actions: [ChangeAction!] }
  input SlotKeyInput { Site: String!, Name: String! }
  enum ChangeAction { CREATED UPDATED DELETED }
  enum ChangeKind { DIRECT PROPAGATED }
  type WidgetChangedEvent { Action: ChangeAction!, ChangeKind: ChangeKind!, Id: String!, Widget: Widget }
  type SlotChangedEvent { Action: ChangeAction!, ChangeKind: ChangeKind!, Slot: Slot }
  type VendorChangedEvent { Action: ChangeAction!, ChangeKind: ChangeKind!, Id: String!, Vendor: Vendor }
  input WidgetWhereInput { Name: StringFilter, VendorId: StringFilter }
  input StringFilter { Eq: String, Contains: String }
  input KeysetPageInput { after: String, limit: Int }
  input UpdateWidgetInput { Name: String }
  type PageInfo { HasNextPage: Boolean!, HasPreviousPage: Boolean!, EndCursor: String, TotalCount: Int }
  type WidgetConnection { Edges: [WidgetEdge!]!, PageInfo: PageInfo! }
  type WidgetEdge { Cursor: String!, Node: Widget! }
  type Widget {
    Id: String!
    Name: String!
    Sku: String
    StockState: String!
    RowVersion: Int!
    Vendor: Vendor
    Spec: WidgetSpec
  }
  type WidgetSpec { Model: String, Code: String }
  type Vendor { Id: String!, DisplayName: String!, Widgets: [Widget!]!, Tickets(Page: PageInput): TicketConnection! }
  type Slot { Site: String!, Name: String!, State: String! }
  type WidgetResult { Success: Boolean!, Error: String, Entity: Widget }
  union SearchHit = Widget | Vendor
`)

export const documents = [
  `fragment WidgetRow on Widget @live {
    Name
    StockState
    Vendor { ...VendorBadge }
  }`,
  `fragment VendorBadge on Vendor @live { DisplayName }`,
  `fragment SlotState on Slot @live { State }`,
  `fragment WidgetDetail on Widget {
    Name
    Sku
    RowVersion
    Spec { Model Code }
  }`,
  `query CatalogPage($Where: WidgetWhereInput) {
    Widgets(Where: $Where, Page: { limit: 50 }) {
      Edges { Cursor Node { ...WidgetRow } }
      PageInfo { HasNextPage EndCursor TotalCount }
    }
  }`,
  `query CatalogScroll($Where: WidgetWhereInput, $Page: KeysetPageInput) {
    Widgets(Where: $Where, Page: $Page) @connection(key: "catalog") {
      Edges { Node { ...WidgetRow } }
      PageInfo { TotalCount }
    }
  }`,
  `query WidgetPage($Id: String!) {
    Widget(Id: $Id) { ...WidgetDetail ...WidgetRow }
  }`,
  `query SlotPage($Site: String!, $Name: String!) {
    Slot(Site: $Site, Name: $Name) { State ...SlotState }
  }`,
  `query SearchPage($Text: String!) {
    Search(Text: $Text) {
      ... on Widget { Name }
      ... on Vendor { DisplayName }
    }
  }`,
  `fragment TicketRow on Ticket @live { Title State }`,
  `query TicketsPage($Where: TicketWhereInput, $Page: PageInput) {
    Tickets(Where: $Where, Page: $Page) @paged {
      Edges { Node { ...TicketRow } }
    }
  }`,
  `query TicketsScroll($Where: TicketWhereInput, $Page: PageInput) {
    Tickets(Where: $Where, Page: $Page) @connection(key: "tickets") {
      Edges { Node { ...TicketRow } }
      PageInfo { TotalCount }
    }
  }`,
  `query LookupName($Text: String!) { LookupName(Text: $Text) }`,
  `query QueueSummary($Queue: String!) {
    TicketSummary(Queue: $Queue) { Open Closed Oldest { Title } }
  }`,
  `query Report($Limit: Int!) { ReportRows(Limit: $Limit) { Label Count } }`,
  `mutation Reopen($Id: String!) {
    ReopenTicket(Id: $Id) { Accepted Message Ticket { ...TicketRow } Audit { At By } }
  }`,
  `mutation Ping { Ping }`,
  `mutation IssueToken($Id: String!) {
    IssueToken(Id: $Id) { Secret Ticket { ...TicketRow } Audit { At By } }
  }`,
  `subscription TicketFeed($Keys: [String!]) {
    TicketChanged(Keys: $Keys) { Action Ticket { ...TicketRow } }
  }`,
  `mutation RenameWidget($Id: String!, $Name: String!) {
    UpdateWidget(Id: $Id, Input: { Name: $Name }) {
      Success
      Entity { ...WidgetRow ...WidgetDetail }
    }
  }`,
]

export const compiled = compile(schema, documents, {
  liveSelection: "as-written",
  keys: { Slot: ["Site", "Name"], PageInfo: null },
  versions: { Widget: "RowVersion" },
})

// These shared fixtures exercise legacy artifact compatibility; R3 tests compile fresh artifacts.
for (const operation of Object.values(compiled.operations)) delete (operation as { lists?: readonly string[] }).lists

export const ops = compiled.operations as Record<
  | "CatalogPage"
  | "CatalogScroll"
  | "WidgetPage"
  | "SlotPage"
  | "SearchPage"
  | "RenameWidget"
  | "TicketsPage"
  | "TicketsScroll"
  | "LookupName"
  | "QueueSummary"
  | "Report"
  | "Reopen"
  | "Ping"
  | "IssueToken"
  | "TicketFeed",
  (typeof compiled.operations)[string]
>
export const frags = compiled.fragments as Record<
  "WidgetRow" | "VendorBadge" | "WidgetDetail" | "SlotState" | "TicketRow",
  (typeof compiled.fragments)[string]
>

export const vendor = (id: string, name: string) => ({ __typename: "Vendor", Id: id, DisplayName: name })

export const widget = (id: string, overrides: Record<string, unknown> = {}) => ({
  __typename: "Widget",
  Id: id,
  Name: `widget-${id}`,
  StockState: "online",
  Vendor: vendor("acme", "Acme"),
  ...overrides,
})

export const catalog = (
  widgets: readonly Record<string, unknown>[],
  page: { hasNext?: boolean; endCursor?: string | null; total?: number } = {}
) => ({
  Widgets: {
    __typename: "WidgetConnection",
    Edges: widgets.map((node) => ({ __typename: "WidgetEdge", Cursor: `c-${String(node.Id)}`, Node: node })),
    PageInfo: {
      __typename: "PageInfo",
      HasNextPage: page.hasNext ?? false,
      EndCursor: page.endCursor ?? (widgets.length ? `c-${String(widgets.at(-1)!.Id)}` : null),
      TotalCount: page.total ?? widgets.length,
    },
  },
})

/** A network whose responses the test supplies per operation name. Built on the shipped test kit. */
export function mockNetwork(responder: (request: OperationRequest) => GraphQLResponse | Promise<GraphQLResponse>) {
  const network: MockNetwork = createMockNetwork({ respond: responder })
  return { network, requests: network.requests }
}

/** A subscription transport the test drives by hand. Built on the shipped test kit. */
export const mockSubscriptions = (): MockStreams => createMockStreams()

export const ticket = (id: string, overrides: Record<string, unknown> = {}) => ({
  __typename: "Ticket",
  Id: id,
  Title: `ticket-${id}`,
  State: "open",
  RecordVersion: 1,
  ...overrides,
})

/** An offset connection page of tickets, as graphql-orm serves `Page: PageInput`. */
export const ticketPage = (
  tickets: readonly Record<string, unknown>[],
  page: { offset?: number; total?: number; hasNext?: boolean } = {}
) => ({
  Tickets: {
    __typename: "TicketConnection",
    Edges: tickets.map((node) => ({ __typename: "TicketEdge", Cursor: `t-${String(node.Id)}`, Node: node })),
    PageInfo: {
      __typename: "PageInfo",
      TotalCount: page.total ?? tickets.length,
      HasNextPage: page.hasNext ?? (page.offset ?? 0) + tickets.length < (page.total ?? tickets.length),
      HasPreviousPage: (page.offset ?? 0) > 0,
      EndCursor: tickets.length ? `t-${String(tickets.at(-1)!.Id)}` : null,
    },
  },
})

/** A server holding `count` tickets t1…tN, served by `Page { Limit, Offset }`. */
export function ticketServer(count: number) {
  let tickets = Array.from({ length: count }, (_, index) => ticket(`t${index + 1}`))
  const mock = mockNetwork(({ name, variables }) => {
    if (name !== "TicketsPage" && name !== "TicketsScroll") throw new Error(`Unexpected ${name}`)
    const page = (variables.Page as { Limit?: number; Offset?: number } | null | undefined) ?? {}
    const where = variables.Where as { State?: { Eq?: string } } | undefined
    const matching = where?.State?.Eq ? tickets.filter((entry) => entry.State === where.State!.Eq) : tickets
    const limit = page.Limit ?? 50
    const offset = page.Offset ?? 0
    return { data: ticketPage(matching.slice(offset, offset + limit), { offset, total: matching.length }) }
  })
  return {
    ...mock,
    tickets: () => tickets,
    setTickets: (next: ReturnType<typeof ticket>[]) => (tickets = next),
  }
}

const manualHoldClients = new WeakSet<import("../src/client.js").Client>()

/** Seed records for tests that hold ids directly rather than opening a query. */
export function seedManualHolds(client: import("../src/client.js").Client): void {
  if (manualHoldClients.has(client)) return
  manualHoldClients.add(client)
  const live = client.live!
  const hold = live.hold.bind(live)
  live.hold = (holder, targets) => {
    for (const [type, ids] of targets) for (const id of ids) {
      const parts = JSON.parse(Buffer.from(id, "base64url").toString()) as unknown[]
      const keys = compiled.live[type]!.keyFields
      const record = client.store.getOrCreate(id, type)
      keys.forEach((key, i) => { if (!record.fields.has(key)) client.store.setField(record, key, parts[i + 1]) })
    }
    hold(holder, targets)
  }
}
