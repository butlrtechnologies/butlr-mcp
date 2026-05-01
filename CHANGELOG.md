# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- `butlr_list_topology` response now exposes a structured `warnings?: TopologyDiagnostic[]` field alongside the legacy prose `warning`. Programmatic consumers can branch on `warnings[].kind` (`partial_topology`, `tag_no_match`, `unknown_tags`, `tag_match_all_unsatisfiable`, `tag_no_associations`, `asset_scope_empty`, `asset_tag_disjoint`, `tag_associations_all_ghost`, `tag_associations_partial_ghost`, `asset_ids_unverified`, `malformed_tag_rows`) instead of regex-matching prose.
- `butlr_list_topology` now emits an `asset_ids_unverified` diagnostic on the dual-typo path with a cold topology cache, so callers know the asset-id sanity check did not run instead of having it silently swallowed.
- Resolver now reports a `droppedRowCount` for tag rows skipped by the defensive id/name guard; both `butlr_list_topology` and `butlr_available_rooms` surface this as a `malformed_tag_rows` diagnostic so upstream contract violations are observable.
- New shared `TagMatch = "all" | "any"` type and `projectValidRefs` helper exported from `src/clients/queries/tags.ts` and `src/utils/tag-resolver.ts` respectively.

### Fixed
- **Cache pollution** — `butlr_search_assets` and `butlr_list_topology` previously shared a topology cache key but wrote different shapes (search wrote raw sites; topology wrote merged sensors/hives). A search-primed cache could cause subsequent topology calls to silently drop device-level matches. The cache key now carries a `devicesMerged` segment so the two consumers cache to disjoint keys; the bug class is now structurally impossible.
- **Sibling leakage** — `filterTopologyByAssets` used to push the entire raw floor whenever any child matched, re-broadening tag-composition AND back to "every node on the floor". The floor is now strict-pruned to matched leaves plus their rendering ancestors (parent room of a matched zone/sensor; parent hive of a sensor matched via `hive_serial`; the room of that parent hive).
- **Ghost-tag diagnostic suppression** — when both `asset_ids` and `tag_names` were supplied and the tag's only associations pointed at deleted entities, the response surfaced a misleading "filters scope disjoint subtrees" warning instead of the actionable "your tag is dangling" diagnostic. The two diagnostics now evaluate independently with explicit root-cause attribution.

### Changed
- `resolveTagNames` now returns a three-way discriminated union (`{ kind: "ok" | "no_match" | "unsatisfiable" }`) instead of a flag-bag. The type structurally prevents callers from reading `resolvedRows` on the non-`ok` branches, eliminating an entire class of "silently broaden match='all' to match='any'" bugs.
- `asTagId` / `asTagName` now reject empty or whitespace-only input at the brand boundary instead of silently producing a worthless brand.

## [0.2.0] - 2026-04-26

### Added
- `butlr_list_tags` — discover the tag vocabulary in an org with per-level usage counts (`applied_to: { rooms, zones, floors }`). Supports `name_contains` substring filter and `min_usage` threshold. Tags are sorted by total usage descending. (Spot-level tags exist in the data model but are not surfaced by this tool.)
- `butlr_available_rooms` response now includes a structured `unknown_tags` field listing any supplied tag names that did not resolve, so consumers can react programmatically without parsing the prose `warning`.

### Fixed
- `butlr_available_rooms` tag filter — the `roomsByTag` query was sending tag names as `tags`, but the API requires tag IDs as `tagIDs`. The tool now resolves tag names to IDs (case-insensitive) via the `tags` query before calling `roomsByTag(tagIDs:)`. The `roomsByTag` response is now correctly unwrapped from its `data` wrapper.
- `butlr_available_rooms` no longer silently relaxes AND semantics when one of the supplied tag names is unknown. Under `tag_match='all'` (the default), an unresolved tag short-circuits to an empty result with a clear error; only `tag_match='any'` continues with the resolved subset and a soft warning.
- Backend GraphQL errors returned via Apollo's `errorPolicy:'all'` are now surfaced as MCP `AUTH_EXPIRED` / `RATE_LIMITED` / `INTERNAL_ERROR` errors instead of being silently coerced into empty result sets.
- Unexpected response shapes from `roomsByTag` and `sites` queries now raise an MCP `INTERNAL_ERROR` (retryable) instead of a generic `Error`.
- `getTimezoneForAsset` now always returns a valid timezone, falling back to `BUTLR_TIMEZONE` (or `UTC`) with an `isFallback` flag when the site has no configured timezone. Occupancy and timeseries responses include a per-asset `timezone_warning` and an enhanced `timezone_note` when a fallback is in use. Timeseries `.window()` aggregation now uses the site timezone for local-aligned bucket boundaries instead of always defaulting to UTC.

### Changed
- `butlr_available_rooms` accepts a new `tag_match` arg (`"all"` default, or `"any"`) controlling multi-tag semantics. Maps to the GraphQL `useOR` parameter.
- Introduced branded `TagId` / `TagName` types at the tag-resolution boundary so the API's name-vs-id distinction is enforced at compile time.

## [0.1.2] - 2026-04-14

### Changed
- Switch npm publish to OIDC trusted publishing — removes NPM_TOKEN secret in favor of GitHub Actions identity verification
- Re-enable `--provenance` flag for cryptographic build attestation now that the repo is public
- Add `npm-publish` GitHub environment with team reviewer gate for deployment protection

### Improved
- Add "When NOT to Use" negative guidance to all 10 tool descriptions for better LLM tool routing
- Replace non-null assertions (`!`) with safe type narrowing via local variables in tool code

## [0.1.1] - 2026-03-20

### Changed
- Replace `undici` with built-in `fetch()` — lowers Node.js requirement from 20 to 18
- Remove `BUTLR_ORG_ID` from required env vars
- Update Claude Code setup docs to use `-e` flags for env vars
- Expand "Getting API Credentials" with self-service instructions for app.butlr.io

### Added
- `llms.txt` for LLM-assisted installation

## [0.1.0] - 2026-03-20

### Added
- 10 MCP tools for occupancy and asset data:
  - `butlr_search_assets` — fuzzy search across sites, buildings, floors, rooms, sensors
  - `butlr_get_asset_details` — comprehensive asset details with batch support
  - `butlr_hardware_snapshot` — device health: online/offline status, battery levels
  - `butlr_available_rooms` — find unoccupied rooms by capacity and tags
  - `butlr_space_busyness` — current occupancy with qualitative labels and trends
  - `butlr_traffic_flow` — entry/exit counts with hourly breakdown
  - `butlr_list_topology` — org hierarchy tree with depth control
  - `butlr_fetch_entity_details` — selective field fetching by entity ID
  - `butlr_get_occupancy_timeseries` — historical occupancy data
  - `butlr_get_current_occupancy` — real-time occupancy snapshot
- GraphQL and REST API clients with OAuth2 token refresh
- Topology and occupancy caching with configurable TTL
- MCP error translation (AUTH_EXPIRED, RATE_LIMITED, VALIDATION_FAILED)
- npm package configuration for one-shot install via `npx`
- GitHub Actions CI and publish workflows
- Project scaffolding: TypeScript strict mode, ESLint v9, Prettier, Vitest
- Pre-commit hooks: typecheck, tests, secret scanning, file size limits
- MIT license, security policy, contributing guidelines
