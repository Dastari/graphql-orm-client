import { buildSchema } from "graphql"
import { compile } from "../src/compiler/index.js"
import type { GraphQLResponse, Network, OperationRequest } from "../src/client.js"
import type { SubscriptionSink } from "../src/live.js"

/** A schema in graphql-orm's shape: PascalCase fields, Id keys, keyset connections, Where inputs. */
export const schema = buildSchema(`
  type Query {
    Devices(Where: DeviceWhereInput, Page: KeysetPageInput): DeviceConnection!
    Device(Id: String!): Device
    Organisation(Id: String!): Organisation
    Slot(Site: String!, Name: String!): Slot
    Search(Text: String!): [SearchHit!]!
    Tickets(Where: TicketWhereInput, Page: PageInput): TicketConnection!
    LookupName(Text: String!): String
    TicketSummary(Queue: String!): TicketSummary
    ReportRows(Limit: Int!): [ReportRow!]!
  }
  type Mutation {
    UpdateDevice(Id: String!, Input: UpdateDeviceInput!): DeviceResult!
    ReopenTicket(Id: String!): ReopenResult!
    Ping: Boolean!
    IssueToken(Id: String!): TokenResult!
  }
  type Subscription {
    DeviceChanged(Filter: SubscriptionFilterInput, Key: String): DeviceChangedEvent!
    SlotChanged(Filter: SubscriptionFilterInput, Keys: [SlotKeyInput!]): SlotChangedEvent!
    OrganisationChanged(Filter: SubscriptionFilterInput): OrganisationChangedEvent!
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
  type DeviceChangedEvent { Action: ChangeAction!, ChangeKind: ChangeKind!, Id: String!, Device: Device }
  type SlotChangedEvent { Action: ChangeAction!, ChangeKind: ChangeKind!, Slot: Slot }
  type OrganisationChangedEvent { Action: ChangeAction!, ChangeKind: ChangeKind!, Id: String!, Organisation: Organisation }
  input DeviceWhereInput { Name: StringFilter, OrganisationId: StringFilter }
  input StringFilter { Eq: String, Contains: String }
  input KeysetPageInput { after: String, limit: Int }
  input UpdateDeviceInput { Name: String }
  type PageInfo { HasNextPage: Boolean!, HasPreviousPage: Boolean!, EndCursor: String, TotalCount: Int }
  type DeviceConnection { Edges: [DeviceEdge!]!, PageInfo: PageInfo! }
  type DeviceEdge { Cursor: String!, Node: Device! }
  type Device {
    Id: String!
    Name: String!
    Hostname: String
    ConnectionState: String!
    RowVersion: Int!
    Organisation: Organisation
    Hardware: DeviceHardware
  }
  type DeviceHardware { Model: String, Serial: String }
  type Organisation { Id: String!, DisplayName: String!, Devices: [Device!]!, Tickets(Page: PageInput): TicketConnection! }
  type Slot { Site: String!, Name: String!, State: String! }
  type DeviceResult { Success: Boolean!, Error: String, Entity: Device }
  union SearchHit = Device | Organisation
`)

export const documents = [
  `fragment DeviceRow on Device @live {
    Name
    ConnectionState
    Organisation { ...OrganisationBadge }
  }`,
  `fragment OrganisationBadge on Organisation @live { DisplayName }`,
  `fragment SlotState on Slot @live { State }`,
  `fragment DeviceDetail on Device {
    Name
    Hostname
    RowVersion
    Hardware { Model Serial }
  }`,
  `query FleetPage($Where: DeviceWhereInput) {
    Devices(Where: $Where, Page: { limit: 50 }) {
      Edges { Cursor Node { ...DeviceRow } }
      PageInfo { HasNextPage EndCursor TotalCount }
    }
  }`,
  `query FleetScroll($Where: DeviceWhereInput, $Page: KeysetPageInput) {
    Devices(Where: $Where, Page: $Page) @connection(key: "fleet") {
      Edges { Node { ...DeviceRow } }
      PageInfo { TotalCount }
    }
  }`,
  `query DevicePage($Id: String!) {
    Device(Id: $Id) { ...DeviceDetail ...DeviceRow }
  }`,
  `query SlotPage($Site: String!, $Name: String!) {
    Slot(Site: $Site, Name: $Name) { State ...SlotState }
  }`,
  `query SearchPage($Text: String!) {
    Search(Text: $Text) {
      ... on Device { Name }
      ... on Organisation { DisplayName }
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
  `mutation RenameDevice($Id: String!, $Name: String!) {
    UpdateDevice(Id: $Id, Input: { Name: $Name }) {
      Success
      Entity { ...DeviceRow ...DeviceDetail }
    }
  }`,
]

export const compiled = compile(schema, documents, {
  keys: { Slot: ["Site", "Name"], PageInfo: null },
  versions: { Device: "RowVersion" },
})

export const ops = compiled.operations as Record<
  | "FleetPage"
  | "FleetScroll"
  | "DevicePage"
  | "SlotPage"
  | "SearchPage"
  | "RenameDevice"
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
  "DeviceRow" | "OrganisationBadge" | "DeviceDetail" | "SlotState" | "TicketRow",
  (typeof compiled.fragments)[string]
>

export const org = (id: string, name: string) => ({ __typename: "Organisation", Id: id, DisplayName: name })

export const device = (id: string, overrides: Record<string, unknown> = {}) => ({
  __typename: "Device",
  Id: id,
  Name: `device-${id}`,
  ConnectionState: "online",
  Organisation: org("acme", "Acme"),
  ...overrides,
})

export const fleet = (
  devices: readonly Record<string, unknown>[],
  page: { hasNext?: boolean; endCursor?: string | null; total?: number } = {}
) => ({
  Devices: {
    __typename: "DeviceConnection",
    Edges: devices.map((node) => ({ __typename: "DeviceEdge", Cursor: `c-${String(node.Id)}`, Node: node })),
    PageInfo: {
      __typename: "PageInfo",
      HasNextPage: page.hasNext ?? false,
      EndCursor: page.endCursor ?? (devices.length ? `c-${String(devices.at(-1)!.Id)}` : null),
      TotalCount: page.total ?? devices.length,
    },
  },
})

/** A network whose responses the test supplies per operation name. */
export function mockNetwork(responder: (request: OperationRequest) => GraphQLResponse | Promise<GraphQLResponse>) {
  const requests: OperationRequest[] = []
  const network: Network = {
    async execute(request, { signal }) {
      requests.push(request)
      const response = await responder(request)
      if (signal?.aborted) throw new DOMException("aborted", "AbortError")
      return response
    },
  }
  return { network, requests }
}

/** A subscription transport the test drives by hand. */
export function mockSubscriptions() {
  const open = new Map<number, { request: OperationRequest; sink: SubscriptionSink }>()
  let next = 0
  const subscribe = (request: OperationRequest, sink: SubscriptionSink) => {
    const id = ++next
    open.set(id, { request, sink })
    return () => {
      open.delete(id)
    }
  }
  const find = (name: string) => [...open.values()].filter((entry) => entry.request.name === name)
  return { subscribe, open, find }
}

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
