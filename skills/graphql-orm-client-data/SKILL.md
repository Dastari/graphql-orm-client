---
name: graphql-orm-client-data
description: Write components with graphql-orm-client fragments and route roots, paginate, refetch and run mutations without request waterfalls or over-fetching.
---

# Fragments, roots, pagination and mutations

Status: design stage. Check the installed `docs/design.md` for the current API.

## Components declare their own data

- Give every component that renders server data its own fragment, in the same file, on the
  type it renders. Name it after the component (`DeviceRow` → `fragment DeviceRow on Device`).
- Read it with `useFragment(Fragment, ref)`. The component receives a fragment reference,
  never a raw result object.
- Select only the fields the component renders. To render a child component, spread the
  child's fragment (`...DeviceHealth`) and pass the reference down. Do not select the child's
  fields in the parent.
- Include the key fields (`Id`, or the entity's complete key). The compiler rejects a fragment
  on a type without a complete key.

## Roots own the request

- Only route-level components write queries. A root spreads its children's fragments and
  supplies variables (`Where`, order, page size).
- Never fetch inside a child component to fill in missing data. Add the field to the child's
  fragment instead, so the root's query includes it.
- Start the root in the route loader (`client.preload`) so the request begins before render.

## Filters and lists

- Map every filter and search onto graphql-orm `Where` inputs. Filtering a downloaded page
  does not filter the dataset.
- Use offset connections for sortable tables and keyset lists for a fixed order.
  `usePagination` handles both.

## Mutations

- Spread the fragments of the views the mutation affects into its selection, so the response
  updates the store.
- Use an optimistic update only when the result is predictable. Give list insertions and
  removals an explicit updater, or let the affected lists refetch.
- Use the generated mutations (`Create…`, `Update…`, `Delete…`). Do not ask the backend for
  hand-written resolvers.
