import { buildSchema } from "graphql"
import { compile } from "../src/compiler/index.js"
import type { GraphQLResponse, Network, OperationRequest } from "../src/client.js"

/** A schema in graphql-orm's shape: PascalCase fields, Id keys, keyset connections, Where inputs. */
export const schema = buildSchema(`
  type Query {
    Devices(Where: DeviceWhereInput, Page: KeysetPageInput): DeviceConnection!
    Device(Id: String!): Device
    Organisation(Id: String!): Organisation
    Slot(Site: String!, Name: String!): Slot
    Search(Text: String!): [SearchHit!]!
  }
  type Mutation {
    UpdateDevice(Id: String!, Input: UpdateDeviceInput!): DeviceResult!
  }
  input DeviceWhereInput { Name: StringFilter, OrganisationId: StringFilter }
  input StringFilter { Eq: String, Contains: String }
  input KeysetPageInput { after: String, limit: Int }
  input UpdateDeviceInput { Name: String }
  type PageInfo { HasNextPage: Boolean!, EndCursor: String, TotalCount: Int }
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
  type Organisation { Id: String!, DisplayName: String!, Devices: [Device!]! }
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
  `fragment OrganisationBadge on Organisation { DisplayName }`,
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
  `query DevicePage($Id: String!) {
    Device(Id: $Id) { ...DeviceDetail ...DeviceRow }
  }`,
  `query SlotPage($Site: String!, $Name: String!) {
    Slot(Site: $Site, Name: $Name) { State }
  }`,
  `query SearchPage($Text: String!) {
    Search(Text: $Text) {
      ... on Device { Name }
      ... on Organisation { DisplayName }
    }
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
  "FleetPage" | "DevicePage" | "SlotPage" | "SearchPage" | "RenameDevice",
  (typeof compiled.operations)[string]
>
export const frags = compiled.fragments as Record<
  "DeviceRow" | "OrganisationBadge" | "DeviceDetail",
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

export const fleet = (devices: readonly Record<string, unknown>[]) => ({
  Devices: {
    __typename: "DeviceConnection",
    Edges: devices.map((node, index) => ({ __typename: "DeviceEdge", Cursor: `c${index}`, Node: node })),
    PageInfo: { __typename: "PageInfo", HasNextPage: false, EndCursor: null, TotalCount: devices.length },
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
