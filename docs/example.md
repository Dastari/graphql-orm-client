# Example: projects and tickets

A small service and the page that uses it. A project has many tickets. The page shows a project's name and its tickets, adds a
ticket and closes one. Edits made anywhere else show up on it while it's open, without a reload.

This exact code was checked on 2026-11-07 against graphql-orm 0.94.0 and graphql-orm-client 0.1.0-alpha.12. The service built
and served the schema, and `schema pull`, `generate` and `tsc` passed on the page. Then the page's documents ran through the client against the
running service, over HTTP and a WebSocket, with no router in between:

- A ticket added from the page appeared in the list.
- A ticket created by another client appeared in title order.
- Closing a ticket updated its row, and reopening it from another client updated it again.
- Renaming the project from another client updated the header.
- A ticket deleted by another client left the list.

The React components themselves weren't rendered in a browser.

## 1. The service

`Cargo.toml`. The three `*-case-pascal` features give the PascalCase names (`Tickets`, `Edges`, `Where`) the client's examples use.

```toml
[dependencies]
graphql-orm = { git = "https://github.com/Dastari/graphql-orm", tag = "graphql-orm-v0.94.0", features = ["sqlite", "resolver-case-pascal", "argument-case-pascal", "field-case-pascal"] }
async-graphql = { version = "7", default-features = false }
async-graphql-axum = "7"
axum = "0.8"
tokio = { version = "1", features = ["macros", "rt-multi-thread", "net"] }
serde = { version = "1", features = ["derive"] }
```

`src/main.rs`:

```rust
use async_graphql::SimpleObject;
use graphql_orm::prelude::*;

#[derive(GraphQLEntity, GraphQLOperations, GraphQLRelations, SimpleObject, Clone, Debug, serde::Serialize, serde::Deserialize)]
#[graphql(complex, rename_fields = "PascalCase")]
#[graphql_entity(backend = "sqlite", table = "projects", plural = "Projects", node_id, default_sort = "name ASC")]
pub struct Project {
    #[primary_key]
    #[filterable(type = "string")]
    pub id: String,
    #[filterable(type = "string")]
    #[sortable]
    pub name: String,
    // A managed version: every write advances it, so the client never lets an older copy replace a newer one.
    #[graphql_orm(version = "managed", default = "0")]
    pub version: i64,
    // One project, many tickets: this becomes `Project.Tickets(Where, OrderBy, Page)`.
    #[graphql(skip)]
    #[serde(default)]
    #[relation(target = "Ticket", from = "id", to = "project_id", multiple)]
    pub tickets: Vec<Ticket>,
}

#[derive(GraphQLEntity, GraphQLOperations, GraphQLRelations, SimpleObject, Clone, Debug, serde::Serialize, serde::Deserialize)]
#[graphql(complex, rename_fields = "PascalCase")]
#[graphql_entity(backend = "sqlite", table = "tickets", plural = "Tickets", node_id, default_sort = "id ASC", keyset = "id asc")]
pub struct Ticket {
    #[primary_key]
    #[filterable(type = "string")]
    #[sortable]
    pub id: String,
    #[filterable(type = "string")]
    pub project_id: String,
    #[filterable(type = "string")]
    #[sortable]
    pub title: String,
    #[filterable(type = "string")]
    pub state: String,
    #[graphql_orm(version = "managed", default = "0")]
    pub version: i64,
    // Each ticket belongs to a project: `Ticket.Project`. "up" also notifies the project when one of its tickets changes.
    #[graphql(skip)]
    #[relation(target = "Project", from = "project_id", to = "id", propagate_change = "up")]
    pub project: Option<Project>,
}

// Each relation target needs a batch loader, keyed by its primary key.
impl BatchLoadEntity for Project {
    fn batch_column() -> &'static str { "id" }
    fn batch_key_from_row(row: &graphql_orm::DbRow) -> Result<String, graphql_orm::sqlx::Error> {
        use graphql_orm::sqlx::Row;
        row.try_get("id")
    }
}
impl BatchLoadEntity for Ticket {
    fn batch_column() -> &'static str { "id" }
    fn batch_key_from_row(row: &graphql_orm::DbRow) -> Result<String, graphql_orm::sqlx::Error> {
        use graphql_orm::sqlx::Row;
        row.try_get("id")
    }
}

// Generated queries, mutations and `Changed` subscriptions for both entities.
schema_roots! {
    backend: "sqlite",
    entities: [Project, Ticket],
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let db = Database::<SqliteBackend>::connect_sqlite("sqlite://app.db?mode=rwc").await?;
    let plan = db.schema().plan_migration_to_entities("init", "app", &[Project::metadata(), Ticket::metadata()]).await?;
    db.schema().apply_migration(&plan, ApplyOptions::default()).await?;
    let schema = schema_builder(db).finish();
    let app = axum::Router::new().route(
        "/graphql",
        axum::routing::post_service(async_graphql_axum::GraphQL::new(schema.clone()))
            .get_service(async_graphql_axum::GraphQLSubscription::new(schema)),
    );
    axum::serve(tokio::net::TcpListener::bind("127.0.0.1:3000").await?, app).await?;
    Ok(())
}
```

`schema_roots!` requires authentication by default, so every request needs an identity from your auth integration. For a local
try-out, `auth: "none"` turns that off, as in graphql-orm's quickstart. Don't deploy it that way. A deployed service usually
sits behind graphql-orm's router; the client is the same either way.

Of the schema this generates, the page uses these parts (abridged):

```graphql
type Project { Id: String!  Name: String!  NodeId: ID!  RecordVersion: Int!
  Tickets(Where: TicketWhereInput, OrderBy: TicketOrderByInput, Page: PageInput): TicketConnection! }
type Ticket { Id: String!  ProjectId: String!  Title: String!  State: String!  NodeId: ID!  RecordVersion: Int! }

type Query { Project(Id: String!): Project  Projects(...): ProjectConnection!  Tickets(...): TicketConnection! }
type Mutation { CreateTicket(Input: CreateTicketInput!): TicketResult!  UpdateTicket(Id: String!, Input: UpdateTicketInput!): TicketResult! }
type Subscription { ProjectChanged(...): ProjectChangedEvent!  TicketChanged(...): TicketChangedEvent! }
```

## 2. Generate the client's types

`graphql-orm-client.config.json`:

```json
{
  "schema": "schema/router.graphql",
  "documents": ["src"],
  "out": "src/graphql/generated.ts"
}
```

```sh
pnpm exec graphql-orm-client schema pull --url http://127.0.0.1:3000/graphql
pnpm exec graphql-orm-client generate
```

Run `generate` again after changing any document or the schema. It writes the types, the composed queries and the live
subscriptions to `src/graphql/generated.ts`.

## 3. One client per signed-in identity

`src/client.ts`:

```ts
import { createClient as createWsClient } from "graphql-ws"
import { createClient, createHttpNetwork, graphqlWsTransport } from "graphql-orm-client"
import { live } from "./graphql/generated"

const ws = createWsClient({ url: "wss://graph.example.com/graphql" })

export const client = createClient({
  network: createHttpNetwork({ url: "/api/graphql" }),
  live: { artifacts: live, ...graphqlWsTransport(ws) },
})
```

`src/App.tsx`:

```tsx
import { ClientProvider } from "graphql-orm-client/react"
import type { ReactNode } from "react"
import { client } from "./client"

export function App({ children }: { children: ReactNode }) {
  return <ClientProvider client={client}>{children}</ClientProvider>
}
```

Dispose the client and make a new one when the signed-in identity changes.

## 4. Components declare their own data

Each component has a fragment on the type it shows, and reads only that. `@live` keeps it current while it's on screen.

`src/ProjectHeader.tsx`:

```tsx
import type { FragmentRefs } from "graphql-orm-client"
import { useFragment } from "graphql-orm-client/react"
import { graphql } from "./graphql/generated"

const ProjectHeaderFragment = graphql(`
  fragment ProjectHeader on Project @live {
    Name
  }
`)

export function ProjectHeader({ project }: { project: FragmentRefs<"ProjectHeader"> }) {
  const { Name } = useFragment(ProjectHeaderFragment, project)
  return <h1>{Name}</h1>
}
```

`src/TicketRow.tsx`. The mutation spreads the row's fragment, so its response updates the row:

```tsx
import type { FragmentRefs } from "graphql-orm-client"
import { useFragment, useMutation } from "graphql-orm-client/react"
import { graphql } from "./graphql/generated"

const TicketRowFragment = graphql(`
  fragment TicketRow on Ticket @live {
    Id
    Title
    State
  }
`)

const CloseTicket = graphql(`
  mutation CloseTicket($Id: String!) {
    UpdateTicket(Id: $Id, Input: { State: "closed" }) {
      Ticket { ...TicketRow }
    }
  }
`)

export function TicketRow({ ticket }: { ticket: FragmentRefs<"TicketRow"> }) {
  const { Id, Title, State } = useFragment(TicketRowFragment, ticket)
  const close = useMutation(CloseTicket)
  return (
    <li>
      {Title} ({State})
      {State !== "closed" && (
        <button disabled={close.inFlight} onClick={() => void close.commit({ Id })}>
          Close
        </button>
      )}
    </li>
  )
}
```

## 5. The route owns the request

The page has one query. It follows the relation from the project to its tickets and spreads each child's fragment, so the
whole page is one request. The route's loader starts it before the page mounts.

`src/ProjectPage.tsx`:

```tsx
import { useState } from "react"
import type { LoadedQuery } from "graphql-orm-client"
import { useLiveHealth, useLoadedQuery, useMutation } from "graphql-orm-client/react"
import { client } from "./client"
import { graphql, type ProjectPageQuery } from "./graphql/generated"
import { ProjectHeader } from "./ProjectHeader"
import { TicketRow } from "./TicketRow"

const ProjectPage = graphql(`
  query ProjectPage($Id: String!) {
    Project(Id: $Id) {
      ...ProjectHeader
      Tickets(OrderBy: { Title: ASC }) {
        Edges { Node { Id ...TicketRow } }
      }
    }
  }
`)

const AddTicket = graphql(`
  mutation AddTicket($Input: CreateTicketInput!) {
    CreateTicket(Input: $Input) {
      Ticket { Id ...TicketRow }
    }
  }
`)

// Call from the route's loader, passing the router's abort signal.
export function loadProjectPage(id: string, signal: AbortSignal) {
  return client.loadQuery(ProjectPage, { Id: id }, { signal })
}

export function ProjectRoute({ id, loaded }: { id: string; loaded: LoadedQuery<ProjectPageQuery> }) {
  const { data, error } = useLoadedQuery(loaded)
  const add = useMutation(AddTicket)
  const [title, setTitle] = useState("")
  if (error) return <p>Couldn't load the project.</p>
  if (!data) return <p>Loading…</p>
  if (!data.Project) return <p>Not found.</p>
  return (
    <main>
      <ProjectHeader project={data.Project} />
      <LiveNotice />
      <ul>
        {data.Project.Tickets.Edges.map(({ Node }) => (
          <TicketRow key={Node.Id} ticket={Node} />
        ))}
      </ul>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          void add.commit({ Input: { ProjectId: id, Title: title, State: "open" } }).then(() => setTitle(""))
        }}
      >
        <input value={title} onChange={(event) => setTitle(event.target.value)} />
        <button disabled={add.inFlight || !title}>Add ticket</button>
      </form>
    </main>
  )
}

// Say so when nothing is keeping the tickets current.
function LiveNotice() {
  const { state } = useLiveHealth("Ticket")
  if (state === "refused" || state === "unavailable") return <p role="status">Live updates unavailable. Reload to see changes.</p>
  return null
}
```

## What keeps it current

Nothing on the page asks for freshness beyond `@live`:

- Because `TicketRow` is `@live`, the page opens one `TicketChanged` stream for its list of tickets. A ticket created,
  changed or deleted anywhere marks the list stale, and the page reads it again. Changes arriving together share one read.
  So the new ticket appears in title order, whoever created it.
- A changed field arrives in its event and updates the row straight away. The managed version keeps an older copy from
  replacing a newer one.
- `ProjectHeader` is `@live`, so a rename arrives on `ProjectChanged`.
- If nothing can keep the tickets current, for example because the router refuses the stream, `useLiveHealth` says so and
  `LiveNotice` shows it. See the [live skill](../skills/graphql-orm-client-live/SKILL.md) for every state.
