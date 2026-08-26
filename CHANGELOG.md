# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.6.0] - 2026-08-25

### Added
- `butlr_traffic_flow` now accepts a sensor ID (`sensor_...`) directly for per-access-point entry/exit counts. Sensors no longer need a room wrapper to be queryable: the tool skips room resolution, filters the reporting query by sensor, and resolves timezone/path from the sensor's room or floor (falling back to UTC with a warning when unassigned). Room-level queries are unchanged; the response `space.type` is `"sensor"` for direct sensor queries. Requested by customers who count per-door traffic without modeling each access point as a room.
- `butlr_traffic_flow` name search now matches sensors as well as rooms, so the capability above is reachable without already knowing the sensor ID ("traffic through the north elevator door").
- `butlr_search_assets` now returns sensors and hives. Its corpus previously held neither: `flattenTopology` reads devices from `floor.sensors`/`floor.hives`, and the topology query selects neither, so every `asset_types: ["sensor"]` search returned zero matches despite `sensor` and `hive` being advertised (and `butlr_hardware_snapshot` pointing callers at it). Devices are now merged onto their floors before flattening, using the same shared merge and the same cache entry as `butlr_list_topology`. Test/mirror devices are excluded, matching that tool.
- `butlr_traffic_flow` warns when a directly queried sensor is marked `UNINSTALLED`, instead of returning a bare zero with no explanation.

### Fixed
- `butlr_traffic_flow` sensor path no longer drops the display path for a sensor whose `room_id` resolves but whose `floor_id` is unset or stale. The path builder keyed off `floor_id` while the timezone chain keyed off `room_id`, so such a sensor got the right timezone and a bare device name; when the two disagreed, the path named the wrong floor and silently dropped the room. Both now resolve room first, floor second, from one shared `resolveSensorContext` helper.
- `butlr_traffic_flow` no longer rejects a real sensor with no MAC recorded as a "test/mirror device". It refused anything `isProductionSensor` refused, and that filter also drops MAC-less placeholder rows, so a provisioned but not yet MAC bound sensor was told it was fake and left unqueryable. The single-sensor path now refuses only a KNOWN test device (new `isKnownTestSensor`: the `mi-rr-or` and `fa-ke` prefixes, the only positive evidence available). `isProductionSensor` keeps its stricter behaviour for aggregate views, where a placeholder row inflates headline totals and `butlr_hardware_snapshot` already reports those rows under `test_devices_excluded.sensors.placeholder`. Excluding an unknown row from a total is cheap; refusing a caller's explicit query for it is not.
- `butlr_traffic_flow` now filters test/mirror devices on the room path too. The same tool reported `sensor_count: 1` for a mirror sensor reached through its room while rejecting that sensor by ID, and disagreed with `butlr_get_current_occupancy` about what the room contained.
- `butlr_traffic_flow`'s UTC fallback warning is now window aware. It was worded for `today` only ("timestamps use UTC midnight as fallback"), but the unassigned-sensor path raises the fallback on every window, so a `20m`/`1h`/`custom` query carried a day-alignment warning about a midnight that was never computed.
- `butlr_traffic_flow` no longer points a rejected presence sensor at a room that does not resolve. A dangling `room_id` sent the caller to `butlr_get_current_occupancy`, which then answered "no sensors configured" for a room that no longer exists.
- Flattened sensors, hives and zones now carry their room linkage (`room_id`, `room_name`). The flattener read only the camelCase `roomID`, which the topology query does not select, so device breadcrumb paths lost their room segment.

### Changed
- `butlr_traffic_flow` resolves a single sensor with `sensors(ids:)` instead of downloading the org's entire sensor inventory and searching it in memory. Besides the payload, the old shape would turn a real sensor into "not found" if the `sensors` root field were ever capped or paged.
- Topology fetching is now composed from `fetchTopology()` + `fetchProductionSensors()` (`fetchTopologyAndSensors()` is unchanged for its callers), so a tool that needs the hierarchy but not the whole inventory can ask for just the hierarchy. `butlr_traffic_flow` no longer carries its own copy of that fetch, which is what let the mirror filtering diverge between it and the occupancy tools.
- `Sensor.mode` is now optional in the client types, as defensive typing: the schema declares `mode: String!` (null is not a reachable wire value), but an empty string or a future mode value is, and the non-optional two-value union made TypeScript narrow `mode !== "traffic"` to `"presence"`, marking the tools' missing-mode guards unreachable.
- `butlr_traffic_flow`'s room branch gates its traffic-sensor check on `isKnownTestSensor` (mirror/fake prefixes) instead of `isProductionSensor`, and fetches the room's sensors via `sensors(room_ids:)` rather than the org-wide inventory. The stricter aggregate filter drops MAC-less placeholder rows, so a room whose traffic sensors were provisioned but not yet MAC-bound was refused with "does not have traffic-mode sensors" where it previously returned counts — and that list only drives the refusal gate and `sensor_count`, never the totals (the reporting API aggregates by room server-side).
- `butlr_traffic_flow` name search picks the highest-ranked candidate that can serve traffic (a room, or a traffic-mode sensor) instead of taking the top match unconditionally — a presence sensor whose name outranked the intended room dead-ended the query with the right room at index 1. `butlr_search_assets` results now carry `mode` for sensors to make that selection possible without resolving each candidate.
- `butlr_search_assets` device fetches now surface GraphQL errors instead of returning `total_matches: 0`, and enforce the same response-shape contract as `butlr_list_topology` before writing the shared merged-devices cache entry — a `data: null` payload would otherwise have been cached as a device-empty org for the rest of the TTL.

## [0.5.1] - 2026-08-05

Adapts every reporting-API query to the Aug 3 reporting-backend cutover (InfluxDB → tiered ETL storage behind the same `/v3/reporting` endpoint). Root-caused and verified against the production API after Salesforce reported `butlr_traffic_flow` failures.

### Fixed
- All reporting tools now send RFC3339-only timestamps: the ETL-backed `/v3/reporting` rejects relative time forms (`-20m`, `-1h`) with a 400, which broke `butlr_traffic_flow` `time_window: 20m/1h` outright. `ReportingRequestBuilder` resolves relative forms and `now` to absolute ISO-8601 (new shared `src/utils/time-resolver.ts`, also used by the time-range validator).
- All reporting queries now send an explicit `filter.stop`: the ETL backend returns an empty result set when `stop` is omitted (the Influx era defaulted to now), which made `time_window: today` and `custom_stop: now` return zeros.
- `butlr_traffic_flow` no longer misses recent activity due to closed-bucket semantics (ETL buckets are end-labeled and only returned once fully closed and materialized; hourly buckets can take up to ~1h to land). Ranges ≤ 2h query 1m buckets; longer ranges merge a 1m tail over the trailing 2 hours, deduplicated per sensor against materialized hourly buckets via interval coverage (correct on non-UTC-aligned local hour grids, e.g. :30-offset timezones). The tail is skipped for historical ranges whose hourly buckets have long since materialized.
- `butlr_traffic_flow` response `period.start_utc`/`stop_utc` now carry real timestamps instead of echoing relative input (`"-20m"`, `"now"`).

### Added
- `butlr_traffic_flow` responses whose window ends near now include a `freshness_note`: traffic events land in the reporting store ~5–6 minutes after they occur (measured against production) and counts are final after ~10 minutes.

## [0.5.0] - 2026-05-13

Four bug fixes surfaced by agent-vs-agent end-to-end validation. All are non-breaking schema-wise; the response **values** for zones change (Fix #1) and one **string** in the response changes (Fix #4). Validation suite vs the prior release baseline: pass rate 26/30 → 30/30; friction-tag count 38 → 26 (-31.6%); errored tool calls 27 → 3.

### Fixed
- `butlr_get_current_occupancy` and `butlr_get_occupancy_timeseries` now report correct `sensor_count` for zones. Previously the responses hardcoded `sensor_count: 0` for every zone based on an incorrect assumption that zones had no client-visible sensor attribution. The GraphQL `zone.sensors` field returns directly-attributed sensors, which the topology query now fetches and `resolveAssetContext` correctly partitions by mode. Zones and rooms are sibling topology elements under a floor — the legacy `zone.room_id` field is decorative and does NOT roll up sensors from any notional parent room. End-to-end validation surfaced callers reporting "no sensors configured" for zones whose sensors were correctly attributed in the data.
- `butlr_space_busyness` no longer errors when computing the trend window. The trend computation called the v4 Stats API with a relative time format (`-4w`); the Stats API only accepts ISO-8601 absolute timestamps. Now converted at the call site.
- `butlr_fetch_entity_details` no longer errors when callers request object-typed fields (`capacity`, collection fields like `rooms`/`zones`/`sensors`, cross-entity references like `floor`/`building`). Previously only `tags` had a hard-coded GraphQL subselection in `FIELD_SELECTIONS`; other object-typed fields fell through and produced `[INTERNAL_ERROR] Field "X" of type "Y!" must have a selection of subfields.` Now every known object-typed field has a sensible default subselection.
- `butlr_get_current_occupancy` now distinguishes "sensors configured but no recent reads" from "no sensors configured" in the `recommendation_reason` and related copy. Previously both surfaced as `"No occupancy data available."`, which downstream LLMs misinterpreted as "the space is unmonitored." The new wording explicitly differentiates a quiet but instrumented space from an uninstrumented one, points users toward `butlr_hardware_snapshot` for sensor-health checks, and pairs with the zone-sensor-count fix landed earlier in this release.

## [0.4.0] - 2026-05-12

### Added
- `butlr_get_asset_details` now returns `tags: [{ id, name }]` on every room, zone, and floor response — closing the asymmetry where callers could find rooms *by* tag (via `butlr_list_tags { include_entities: true }` or `butlr_list_topology { tag_names: [...] }`) but couldn't see *which* tags a known asset carries. Buildings and sites do not have tags in the data model, so their responses are unchanged. The field is always present (`[]` when the asset has no tags) so consumers can rely on a stable response shape. The shape `{id, name}` mirrors the `TaggedEntityRef` projection used elsewhere for consistency. Adds an integration-test suite for `butlr_get_asset_details` (previously uncovered).

## [0.3.0] - 2026-05-12

### Added
- `butlr_list_topology` response now exposes a structured `warnings?: TopologyDiagnostic[]` field alongside the legacy prose `warning`. Programmatic consumers can branch on `warnings[].kind` (`partial_topology`, `tag_no_match`, `unknown_tags`, `tag_match_all_unsatisfiable`, `tag_no_associations`, `asset_scope_empty`, `asset_tag_disjoint`, `tag_associations_all_ghost`, `tag_associations_partial_ghost`, `asset_ids_unverified`, `malformed_tag_rows`, `depth_excludes_matches`, `tag_match_all_no_overlap`) instead of regex-matching prose.
- `butlr_list_topology` now emits an `asset_ids_unverified` diagnostic on the dual-typo path with a cold topology cache, so callers know the asset-id sanity check did not run instead of having it silently swallowed.
- `butlr_list_topology` `tag_match_all_no_overlap` diagnostic — when every requested tag resolves and each has associations but the per-tag subtree intersection is empty. Distinguishes "no tag has associations" (`tag_no_associations`) from "the tags' subtrees don't overlap" (this kind), so the user gets actionable advice (try `'any'`, drop a tag) instead of an empty tree with no signal.
- `butlr_list_topology` `depth_excludes_matches` diagnostic — when the filter resolves to real entities but the `starting_depth`/`traversal_depth` window slices them out of the rendered tree. Pre-fix the user got `tree: []` and no signal.
- `butlr_list_topology` `tag_match_all_unsatisfiable.partial_resolved_count` — surfaces how many of the requested names DID resolve when the `'all'` AND is unsatisfiable, so the operator can tell "1 of 2 unknown" from "2 of 5 unknown".
- `butlr_list_tags` `include_entities: true` — surfaces every tagged room/zone/floor id+name (not just counts) in one call, eliminating the need for per-tag follow-ups to `butlr_get_asset_details`.
- `butlr_list_tags` response now includes a `warning?` field when upstream returns rows with missing/empty id or name fields, mirroring the topology tool's `malformed_tag_rows` diagnostic.
- `ListTopologyResponse`, `TopologyNode`, and every embedded array on `TopologyDiagnostic` / `ListTagsResponse` are now `ReadonlyArray<...>` / readonly tuples — public-API surface change for TypeScript consumers (zero wire impact).
- Resolver now reports a `droppedRowCount` for tag rows skipped by the defensive id/name guard; both `butlr_list_topology` and `butlr_available_rooms` surface this as a `malformed_tag_rows` diagnostic so upstream contract violations are observable.
- New shared `TagMatch = "all" | "any"` type and `projectValidRefs` helper exported from `src/clients/queries/tags.ts` and `src/utils/tag-resolver.ts` respectively.

### Fixed
- `butlr_space_busyness` no longer fails with a misleading "Room/Zone not found" error for valid IDs whose sites have a `timezone` configured. The `GET_ROOM` and `GET_ZONE` queries now select `site { id timezone }` instead of `site { timezone }` alone — Apollo Client 4's cache normalization requires the keyField declared in `graphql-client.ts` typePolicies, and a missing `id` silently set `result.data` to `undefined` under `errorPolicy: 'all'`. Surfaced via customer feedback against v0.2.0.
- `butlr_traffic_flow` now counts room-level traffic from every traffic-mode sensor bound to the room, not just sensors with `is_entrance === false`. `is_entrance` is a semantic flag (does this sensor sit at a building/floor entrance), not a routing one — the Reporting API aggregates by `room_id` regardless. Pre-fix the tool reported "does not have traffic-mode sensors" for cafés and similar rooms whose sensors are all entrances. Same fix applied to room-level traffic resolution in `butlr_get_current_occupancy` and `butlr_get_occupancy_timeseries`. Floor-level traffic still filters to `is_entrance === true` (correct).
- `butlr_get_current_occupancy` and `butlr_get_occupancy_timeseries` now query `zone_occupancy` for zones regardless of client-visible sensor count. Zones don't share sensor attribution with rooms — `zone_occupancy` is computed server-side and has no client-side sensor roll-up. The previous behavior gated the query on `presenceSensors.length > 0`, which was always 0 for zones, so the tools silently reported `available: false` even when the Reporting API had data. Sensor count is correctly still reported as 0 for zones.
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
