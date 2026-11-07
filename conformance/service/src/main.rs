//! Test-owned, loopback-only ORM service. Never deploy this auth-free fixture.
use async_graphql::{Request, SimpleObject};
use axum::{
    Json, Router,
    extract::State,
    routing::{get, post},
};
use graphql_orm::prelude::*;

#[derive(GraphQLEntity, GraphQLOperations, Clone, Debug, serde::Serialize, serde::Deserialize)]
#[graphql_entity(
    backend = "sqlite",
    table = "widgets",
    plural = "Widgets",
    aggregate = true,
    node_id,
    auth = "none",
    default_sort = "id ASC",
    keyset = "id asc"
)]
struct Widget {
    #[primary_key]
    #[graphql_orm(auto_generated = false)]
    #[filterable(type = "string")]
    #[sortable]
    id: String,
    #[filterable(type = "string")]
    #[sortable]
    name: String,
    #[graphql_orm(version = "managed", default = "0")]
    version: i64,
}
#[derive(GraphQLEntity, GraphQLOperations, Clone, Debug, serde::Serialize, serde::Deserialize)]
#[graphql_entity(
    backend = "sqlite",
    table = "vendors",
    plural = "Vendors",
    federation_key,
    auth = "none"
)]
struct Vendor {
    #[primary_key]
    #[graphql_orm(auto_generated = false)]
    #[filterable(type = "string")]
    #[sortable]
    id: String,
    name: String,
}
#[derive(GraphQLEntity, GraphQLOperations, Clone, Debug, serde::Serialize, serde::Deserialize)]
#[graphql_entity(
    backend = "sqlite",
    table = "slots",
    plural = "Slots",
    node_id,
    repository_mutations = true,
    auth = "none"
)]
struct Slot {
    #[primary_key]
    #[graphql_orm(auto_generated = false)]
    #[filterable(type = "string")]
    #[sortable]
    site: String,
    #[primary_key]
    #[graphql_orm(auto_generated = false)]
    name: String,
    label: String,
}
#[derive(
    GraphQLEntity,
    GraphQLRelations,
    GraphQLOperations,
    SimpleObject,
    Clone,
    Debug,
    serde::Serialize,
    serde::Deserialize,
)]
#[graphql(complex, rename_fields = "PascalCase")]
#[graphql_entity(
    backend = "sqlite",
    table = "tickets",
    plural = "Tickets",
    auth = "none"
)]
#[graphql_orm(compose_complex_object)]
struct Ticket {
    #[primary_key]
    #[graphql_orm(auto_generated = false)]
    #[filterable(type = "string")]
    #[sortable]
    id: String,
    vendor_id: String,
    title: String,
    #[graphql(skip)]
    #[relation(target = "Vendor", from = "vendor_id", to = "id", propagate_change = "up")]
    vendor: Option<Vendor>,
}
#[graphql_complex_object]
impl Ticket {
    #[graphql(name = "RecordVersion")]
    async fn record_version(&self) -> i64 {
        1
    }
    #[graphql(name = "Summary")]
    async fn summary(&self) -> String {
        format!("Ticket: {}", self.title)
    }
}
impl BatchLoadEntity for Vendor {
    fn batch_column() -> &'static str {
        "id"
    }
    fn batch_key_from_row(row: &graphql_orm::DbRow) -> Result<String, graphql_orm::sqlx::Error> {
        use graphql_orm::sqlx::Row;
        row.try_get("id")
    }
}
#[derive(Default)]
struct FaultStreams;
#[async_graphql::Subscription]
impl FaultStreams {
    // Deterministic test-owned channels exercise the ORM continuity adapter,
    // rather than relying on socket backpressure to overflow a global ORM bus.
    #[graphql(name = "ContinuityLost")]
    async fn continuity_lost(
        &self,
    ) -> impl graphql_orm::futures::Stream<Item = async_graphql::Result<i32>> {
        let (tx, rx) = tokio::sync::broadcast::channel(1);
        tx.send(1).unwrap();
        tx.send(2).unwrap();
        graphql_orm::graphql::subscriptions::continuity_events(rx)
    }
    #[graphql(name = "SourceClosed")]
    async fn source_closed(
        &self,
    ) -> impl graphql_orm::futures::Stream<Item = async_graphql::Result<i32>> {
        let (tx, rx) = tokio::sync::broadcast::channel::<i32>(1);
        drop(tx);
        graphql_orm::graphql::subscriptions::continuity_events(rx)
    }
}
schema_roots! { backend: "sqlite", auth: "none", query_custom_ops: [], extra_subscription_types: [FaultStreams], generated_mutations: "denylist", generated_mutation_denylist: [Slot], entities: [Widget, Vendor, Slot, Ticket], }

static REFUSING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
struct AllowEntity;
impl EntityPolicy for AllowEntity {
    fn can_access_entity<'a>(
        &'a self,
        _: Option<&'a async_graphql::Context<'_>>,
        _: &'a Database,
        _: &'static str,
        _: Option<&'static str>,
        _: EntityAccessKind,
        surface: EntityAccessSurface,
    ) -> graphql_orm::futures::future::BoxFuture<'a, async_graphql::Result<bool>> {
        Box::pin(async move {
            Ok(surface != EntityAccessSurface::GraphqlSubscription
                || !REFUSING.load(std::sync::atomic::Ordering::SeqCst))
        })
    }
}
static PREIMAGE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
struct Rows;
impl RowPolicy for Rows {
    fn read_visibility<'a>(
        &'a self,
        _: Option<&'a async_graphql::Context<'_>>,
        _: &'a Database,
        _: &'static str,
        _: Option<&'static str>,
        _: EntityAccessSurface,
    ) -> graphql_orm::futures::future::BoxFuture<'a, async_graphql::Result<ReadVisibility>> {
        Box::pin(async { Ok(ReadVisibility::Unrestricted) })
    }

    fn can_read_row<'a>(
        &'a self,
        _: Option<&'a async_graphql::Context<'_>>,
        _: &'a Database,
        _: &'static str,
        _: Option<&'static str>,
        _: EntityAccessSurface,
        _: &'a (dyn std::any::Any + Send + Sync),
    ) -> graphql_orm::futures::future::BoxFuture<'a, async_graphql::Result<bool>> {
        Box::pin(async { Ok(true) })
    }
    fn can_write_row<'a>(
        &'a self,
        _: Option<&'a async_graphql::Context<'_>>,
        _: &'a Database,
        _: &'static str,
        _: Option<&'static str>,
        _: EntityAccessSurface,
        _: &'a (dyn std::any::Any + Send + Sync),
    ) -> graphql_orm::futures::future::BoxFuture<'a, async_graphql::Result<bool>> {
        Box::pin(async { Ok(true) })
    }
    fn can_read_deleted_preimage<'a>(
        &'a self,
        _: Option<&'a async_graphql::Context<'_>>,
        _: &'a Database,
        _: &'static str,
        _: Option<&'static str>,
        _: EntityAccessSurface,
        _: &'a (dyn std::any::Any + Send + Sync),
    ) -> graphql_orm::futures::future::BoxFuture<'a, async_graphql::Result<bool>> {
        Box::pin(async { Ok(PREIMAGE.load(std::sync::atomic::Ordering::SeqCst)) })
    }
}
async fn graphql(
    State(schema): State<AppSchema>,
    Json(request): Json<Request>,
) -> Json<async_graphql::Response> {
    let response = schema.execute(request).await;
    if !response.errors.is_empty() {
        eprintln!("GraphQL errors: {:?}", response.errors);
    }
    Json(response)
}
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter("graphql_orm=debug")
        .with_writer(std::io::stderr)
        .init();
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("--fingerprint") {
        use graphql_orm_router_protocol::SubgraphDescriptor;
        let mut d: SubgraphDescriptor = serde_json::from_str(&std::fs::read_to_string(&args[2])?)?;
        d.fingerprints.schema =
            graphql_orm_router_protocol::Fingerprint::sha256(std::fs::read_to_string(&args[3])?);
        d.fingerprints.authorization = d.authorization_fingerprint();
        d.fingerprints.combined = d.combined_fingerprint();
        println!("{}", serde_json::to_string(&d)?);
        return Ok(());
    }
    let port = std::env::var("SERVICE_PORT")?.parse::<u16>()?;
    let mut db = Database::<SqliteBackend>::connect_sqlite("sqlite::memory:").await?;
    // Keep the generated service's bus out of the router-buffer burst test. The
    // deterministic FaultStreams checks still exercise service continuity loss.
    db.set_event_channel_capacity(8192);
    db.set_entity_policy(AllowEntity);
    db.set_row_policy(Rows);
    let plan = db
        .schema()
        .plan_migration_to_entities(
            "init",
            "conformance",
            &[
                Widget::metadata(),
                Vendor::metadata(),
                Slot::metadata(),
                Ticket::metadata(),
            ],
        )
        .await?;
    db.schema()
        .apply_migration(&plan, ApplyOptions::default())
        .await?;
    Vendor::insert(
        &db,
        CreateVendorInput {
            id: "v1".into(),
            name: "Vendor".into(),
        },
    )
    .await?;
    Slot::insert(
        &db,
        CreateSlotInput {
            site: "north".into(),
            name: "a".into(),
            label: "First".into(),
        },
    )
    .await?;
    let slot_writes = db.clone();
    let schema = schema_builder(db)
        .enable_subscription_in_federation()
        .finish();
    let sdl = schema.sdl_with_options(async_graphql::SDLExportOptions::new().federation());
    use graphql_orm_router_protocol::{CapabilitySet, Fingerprint, SubgraphDescriptorBuilder};
    let mut builder = SubgraphDescriptorBuilder::new(
        "widgets",
        "widgets",
        format!("http://127.0.0.1:{port}/graphql"),
        format!("http://127.0.0.1:{port}/sdl"),
        Fingerprint::sha256(&sdl),
    )?
    .websocket(format!("ws://127.0.0.1:{port}/graphql"))?
    .capabilities(CapabilitySet {
        subscriptions: true,
        authorization_metadata: true,
        schema_fingerprints: true,
    });
    for op in graphql_orm_operation_catalog().router_protocol_operations()? {
        builder = builder.operation(op);
    }
    for field in ["ContinuityLost", "SourceClosed"] {
        builder = builder.operation(graphql_orm_router_protocol::OperationDescriptor {
            root_type: graphql_orm_router_protocol::RootOperationType::Subscription,
            field_name: field.into(),
            arguments: vec![],
            authorization: graphql_orm_router_protocol::AuthorizationRequirement::Public,
        });
    }
    let descriptor = builder.build()?;
    let app = Router::new()
        .route(
            "/graphql",
            post(graphql).get_service(async_graphql_axum::GraphQLSubscription::new(schema.clone())),
        )
        .route(
            "/refuse",
            post(|| async {
                REFUSING.store(true, std::sync::atomic::Ordering::SeqCst);
                "ok"
            }),
        )
        .route(
            "/accept",
            post(|| async {
                REFUSING.store(false, std::sync::atomic::Ordering::SeqCst);
                "ok"
            }),
        )
        .route(
            "/preimage",
            post(|| async {
                PREIMAGE.store(true, std::sync::atomic::Ordering::SeqCst);
                "ok"
            }),
        )
        // A composite-key entity has no generated GraphQL mutation, so this is how an event of its type starts.
        .route(
            "/slot",
            post(move |label: String| {
                let db = slot_writes.clone();
                async move {
                    let key = SlotKey {
                        site: "north".into(),
                        name: "a".into(),
                    };
                    let input = UpdateSlotInput {
                        label: Some(label),
                        ..Default::default()
                    };
                    Slot::update_by_key(&db, &key, input).await.unwrap();
                    "ok"
                }
            }),
        )
        .route("/sdl", get(move || async move { sdl }))
        .route(
            "/.well-known/graphql-router",
            get(move || async move { Json(descriptor) }),
        )
        .with_state(schema);
    axum::serve(
        tokio::net::TcpListener::bind(("127.0.0.1", port)).await?,
        app,
    )
    .await?;
    Ok(())
}
