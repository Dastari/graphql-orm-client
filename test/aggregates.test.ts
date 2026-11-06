import { execFileSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { buildSchema } from "graphql"
import { expect, it } from "vitest"
import { compile, generate } from "../src/compiler/index.js"
const schema = buildSchema(`
 input Filter { Id: String }
 input Metric { Operator: String! }
 type Widget { Id: ID! Name: String! }
 type Edge { Node: Widget! }
 type PageInfo { TotalCount: Int! }
 type Connection { Edges: [Edge!]! PageInfo: PageInfo! }
 enum Kind { COUNT NULL }
 type Value { Field: String Operator: String Kind: Kind! Value: String }
 type GraphqlAggregateResultRow { Groups: [Value!]! Metrics: [Value!]! }
 type Query { Rows(Where: Filter): Connection! UnrelatedName(Where: Filter, Metrics: [Metric!]): [GraphqlAggregateResultRow!]! }
 type Event { Action: String! Widget: Widget }
 type Subscription { WidgetChanged: Event! }
`)
const docs = [
 `fragment Live on Widget @live { Name }`,
 `query Totals { a: Rows { PageInfo { n: TotalCount } } b: Rows { PageInfo { TotalCount } } summary: UnrelatedName { Metrics { Kind Value } } }`,
]
it("derives aggregates from shared input types, honours aliases and live opt-in", () => {
 expect(compile(schema, docs).operations.Totals!.lists).toEqual(["Widget"])
 expect(compile(schema, [docs[1]!]).operations.Totals!.lists).toEqual([])
 const source = generate(schema, docs)
 expect(source).toContain('readonly n: number')
 expect(source).toContain('readonly Value: string | null')
 expect(source).toContain('readonly Kind:')
 expect(source).toContain('readonly summary:')
})

it("typechecks generated aliases, aggregate nullability and enum values", () => {
 const dir = resolve("test/generated/aggregate-types")
 mkdirSync(dir, { recursive: true })
 writeFileSync(`${dir}/graphql.ts`, generate(schema, docs, { importFrom: "../../../src/index.js" }))
 writeFileSync(`${dir}/consumer.ts`, `import type { TotalsQuery } from "./graphql.js"
declare const data: TotalsQuery
const count: number = data.a.PageInfo.n
const second: number = data.b.PageInfo.TotalCount
const value: string | null = data.summary[0]!.Metrics[0]!.Value
// @ts-expect-error exact aggregate values are strings, never floating point numbers
const wrong: number = data.summary[0]!.Metrics[0]!.Value
// @ts-expect-error nullable aggregate values require handling
const nonnull: string = data.summary[0]!.Metrics[0]!.Value
`)
 execFileSync(process.execPath, [resolve("node_modules/typescript/bin/tsc"), "--ignoreConfig", "--noEmit", "--strict", "--skipLibCheck", "--types", "node", "--target", "ES2022", "--module", "NodeNext", `${dir}/consumer.ts`], { stdio: "pipe" })
})
