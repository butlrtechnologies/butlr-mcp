# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed
- `isDSTActive` compared UTC offset strings, which sort the wrong way west of UTC, so New York in EDT reported `dst_active: false` (and every US site had DST inverted). Offsets are now compared as numbers.
- `MCP_CACHE_TOPO_TTL` and `MCP_CACHE_OCCUPANCY_TTL` are validated as whole seconds. Before, `0` or a non-number made entries never expire, and a negative value or a fraction crashed the server at import. `0` now disables the cache. Anything else that isn't whole seconds falls back to the default with a warning on stderr.
- A GraphQL HTTP failure (Apollo 4 `ServerError`) is now mapped by status: 429 to `RATE_LIMITED` (with `retry-after`), 401/403 to `AUTH_EXPIRED`, 400 to `VALIDATION_FAILED`. It used to surface as `INTERNAL_ERROR`, because only the Apollo 3 `networkError` shape was read.
- A batch that names the same sensorless or archived space twice now sends one history-end lookup, not two, as the history-end cache's header already promised.
- `formatDayAndTime`'s "handles noon correctly" test failed under `TZ=Pacific/Auckland`/`Pacific/Kiritimati` (noon UTC is already Thursday there); it now pins its timezone.

## [0.7.0] - 2026-10-23

Archived spaces and replaced-space links. When a floor is re-drawn (Salesforce Indy Tower Floor 7: the "Pilot - *" rooms were archived and "_V2" copies took over their sensors), the old rooms are now marked archived and the new ones point back at them, instead of the tools guessing from a 0-sensor count. Needs the API fields `archivedAt` and `replacesID` on `Room` and `Zone`; uses `sensorsRemovedAt` (API #3038) too once it exists. Until the API ships them, nothing shows as archived (see Compatibility).

### Added
- `GET_FULL_TOPOLOGY`, the four `butlr_available_rooms` room queries and `butlr_space_busyness`'s `GetRoom`/`GetZone` select `archivedAt`, `replacesID` and `sensorsRemovedAt` on rooms and zones. The room queries and `GetRoom`/`GetZone` also select the attributed sensor IDs. The `Room`/`Zone` client types and the occupancy tools' asset context carry these fields, along with the predecessor and successors resolved from the topology.
- `butlr_list_topology` keeps archived rooms and zones in the tree and appends "(archived YYYY-MM-DD)" to their display name, dated in the site's timezone. Its description says they have no live data, and that the last full day of their recorded history comes back as `history_end` from the occupancy tools. That day is no later than the day before the archive date, and can be much earlier.
- `butlr_search_assets` still matches archived rooms and zones by name, since users ask for old rooms by name. Their `path` ends in "(archived YYYY-MM-DD)" and they carry `archived_at`. `name` is left plain so it can be passed to tools that accept names. Rooms and zones return `replaces` and `replaced_by` as `{ id, name }` objects (with `archived_at` on an archived one), the same shape the occupancy and busyness tools use. Successors come from a `replacesID` index built once per search over the whole org, so an old room found by name points at its replacement even when the replacement's name did not match the query.
- `butlr_get_occupancy_timeseries` and `butlr_get_current_occupancy` return `archived_at`, `replaces`, `replaced_by` and a `history_note` for rooms and zones. A space that replaced another names its predecessor, its archive date, and the ID to query for history before the switch-over. Series are not merged.
- One rule decides which spaces are **retired**, in every tool (`isRetired`, contract Addendum 3, E4): no sensor of any kind attributed (test/mirror and MAC-less rows included), AND archived or with `sensorsRemovedAt` set. A retired space is never read live: occupancy tools report no live data, `butlr_space_busyness` returns `current: null`, `butlr_available_rooms` leaves it out of the listing and the room counts, and `butlr_traffic_flow` says it has no live traffic. A space that still has sensors is live, whatever its archive fields say. An archived space with sensors (bad data; the API refuses to archive one) is read live and marked: with a note in the occupancy tools, with a warning in busyness, and with `archived_at` plus a warning in `butlr_available_rooms`. A zone that is not retired is read like any zone, even with no attributed sensors, because zone occupancy can come from overlapping floor sensors. An ID that doesn't resolve is never retired.
- `history_end`, matching the dashboard (#1772/#1775), with a shared conformance table (`src/__fixtures__/history-end-conformance.json`) that the dashboard mirrors. The value is the last full local day of recorded history (contract Addendum 3, E2/E3):
  - The data-derived end is the recorded day before the newest one, or the only day if there is just one. Reporting returns today's partial bucket whenever a space has rows today, and the day its sensors left is partial too, so the newest day is always partial. Days with 0 occupancy count as history.
  - The declared end is the day before the local date of `sensorsRemovedAt`, or else of `archivedAt`.
  - `history_end` is min(declared, data-derived), so data that stopped months before an archive gives the earlier date. If no row falls on or before the declared day, there is no history.
  - A declared end older than the lookup window is returned without a query, flagged as "before the lookup window, so not checked against the data".

  One reporting query per space reads the daily max of `room_occupancy`/`zone_occupancy` with `value >= 0`, from local midnight 177 days back up to now. That start stays on the warm storage tier for every IANA zone and month end with clock skew (contract Addendum 3, E1; tested against a port of the router with a separate server clock). Answers are cached in-process for 10 minutes per space, timezone and declared end. The TTL is set by `MCP_CACHE_HISTORY_END_TTL` in whole seconds; `0` turns the cache off, and anything else falls back to 600 with a warning instead of failing at startup. The variable is documented in the README and CLAUDE.md env tables.
- Which spaces get that query: retired spaces in both occupancy tools, plus, in `butlr_get_occupancy_timeseries`, a room with no sensors attributed. `butlr_get_current_occupancy` doesn't probe a room that just has no sensors yet; its note points at the timeseries tool.

### Changed
- The presence `coverage_note` for these spaces reads "No sensors assigned (archived on <date>). Recorded history runs up to <history end>." When the space isn't archived, the parenthetical names the sensor removal date, or is left out. When the window holds nothing, the note says "No recorded history since <window start>", because older history may exist. Current occupancy keeps a pointer to `butlr_get_occupancy_timeseries` in the `history_note` of every retired space. Its coverage note carries the pointer only when no lookup ran (a room with no sensors that isn't retired) or the lookup failed. This replaces 0.6.2's "recorded by sensors assigned to it earlier" note for rooms. Floors with 0 sensors, and rooms whose only sensors are traffic sensors, keep the 0.6.2 note.
- `butlr_get_occupancy_timeseries` cuts a retired space's series at its removal instant (`sensorsRemovedAt`, else `archivedAt`), because a parked space can keep receiving 0-valued rows. Points from buckets that start at or after that instant are dropped, and the note says how many. A bucket that straddles it keeps the readings from before the sensors left. The cut applies whatever the history lookup returned (an end, no history, or a failure). A space that is not retired is never cut, since a data-derived end is not a removal time. `available` is derived from what remains.
- `history_end_unverified: true` accompanies a `history_end` that is a declared end older than the lookup window.
- When there is no usable reading, `recommendation_reason` for a retired space states what is known without blaming a cause. In the timeseries tool it reads "No readings in the requested time range. This room has no sensors assigned (archived on ...)", followed by the history end and any replacement. It avoids the phrase "no occupancy data". A sensorless room that isn't retired gets the same message when history was found; with none, it keeps the "instrument it" advice.
- Reporting failures on these spaces use one classifier for the range query and the history lookup. A 408, 429, 5xx or timeout is reported on that asset alone, with a `history_warning` asking for a retry when the history lookup is what failed. Any other 4xx fails the call. An unrecognized site timezone sends no query and gives a `history_warning` saying a retry won't help.
- When a reporting API error reaches a tool handler, the handler now maps its status to the MCP code: 400 is `VALIDATION_FAILED`, 401/403 `AUTH_EXPIRED`, 404 `NOT_FOUND`, 408 and 5xx `NETWORK_ERROR` (retryable), and 429 `RATE_LIMITED`. Before, these all came back as `INTERNAL_ERROR`. Two paths used to lose the status before it got there, and now keep it:
  - `butlr_traffic_flow` re-wrapped the error.
  - `getCurrentOccupancy`, used by `butlr_space_busyness` and `butlr_available_rooms`, swallowed a failed presence query, so busyness answered "Quiet (0 people)" on a 401, 429 or 500. It now fails with the presence error unless the traffic query returned readings to fall back on. `butlr_available_rooms` fails with a 401/403/400. On a transient failure it keeps its degraded path, and with no cached data it fails with the reporting status.
- `butlr_get_current_occupancy` runs its history lookups (at most 5 at a time) alongside its live reads, and awaits them only after the live reads finish.
- `butlr_space_busyness` handles retired spaces by name or by ID. If the space has exactly one successor that isn't retired (by `isRetired`, so an archived successor that still has sensors counts as live), the tool reports the successor and the `warning` says "showing its replacement". In every other case it returns the retired space itself, with `current: null`, no live query, a `history_note` pointing at `history_end`, and any successors in `space.replaced_by`. That covers no replacement, a split, a successor that turns out to be retired (said as such, never offered "for live busyness"), and a successor that can't be loaded; the last case adds a warning with the error. Search results and the cached topology supply successors only when that source already had the space archived with at least one successor; otherwise the topology is fetched. If that fetch fails, the tool still answers, with a warning. `SpaceBusynessResponse.current` is now nullable.

### Fixed
- `getLocalMidnight` landed days early on the 1st of a month for sites west of UTC, and around other month and year boundaries. UTC midnight on Nov 1, which is still Oct 31 in Los Angeles, was read as "a day ahead" and the result walked back to Oct 28. This affected `butlr_traffic_flow` "today", which counted about four extra days of traffic for US sites on the 1st of every month.
- `getLocalMidnight` returned 23:00 of the previous day where DST starts at midnight (Africa/Cairo on 2026-04-24, Asia/Beirut on 2026-03-29). It now binary-searches for the first instant whose local date is the target day, which is 01:00 where 00:00 doesn't exist. It is no longer thrown off by ICU builds that print midnight as hour 24.
- `butlr_get_occupancy_timeseries`'s range check and `butlr_traffic_flow`'s window choice resolve both ends of a range from one clock read. Exactly 1h no longer fails the 1m limit, and exactly 2h now uses 1m buckets.

### Compatibility
- A GraphQL server rejects a whole query that selects a field its schema lacks, and this release may ship before the API. A schema check (`__type(name: "Room")` and `"Zone"` `{ fields { name } }`, with its own 10 s timeout) decides which optional fields to keep. A field is kept only when both types have it. The answer is re-checked hourly; a stale answer keeps serving while the re-check runs, so only a process's first query waits. A failed check keeps the last good answer and retries in five minutes; only with no good answer yet does it strip every optional field. If a query is still rejected with `GRAPHQL_VALIDATION_FAILED`, for example because a rolling deploy or rollback put an older API task behind the load balancer, the cached answer is dropped and the query is retried once with every optional field stripped. `queryWithArchiveFallback` takes one document, strips selections with a memoized graphql `visit`, and reports `omittedFields`.
- The merged org topology cache shared by `butlr_list_topology`, `butlr_search_assets` and busyness is keyed on the optional fields its fetch left out, so a tree fetched without them is never served once the API has them. Entries expire 10 minutes after the fetch however often they are read (`updateAgeOnGet: false`). On a stripped query no space is known to be archived, and sensorless rooms still get the data-derived history end.

## [0.6.2] - 2026-10-22

### Fixed
- `butlr_get_occupancy_timeseries` now queries room and floor presence even when the asset has 0 sensors today. A room whose sensors were moved to a re-mapped copy keeps its history under its own `room_id`, but the tool skipped the query on the current sensor count and answered "No presence sensors on this room" for past ranges the Reporting API could serve. When such an asset returns data, `available` is true and `coverage_note` says the history came from sensors assigned earlier. With no data, the response is unchanged; v3 does not zero-fill empty windows (checked against prod), so a dataless room returns an empty series rather than a flat one.
- The lookup for a 0-sensor room or floor is best-effort. A 429, 5xx or timeout on it sets a warning on that asset instead of failing the whole batch, and its `coverage_note` says the lookup failed rather than that there is no history. Auth errors still fail the call, as do 4xx errors on assets that have sensors.
- Assets are processed up to 5 at a time (presence and traffic in parallel per asset) instead of serially, so a large batch of mostly sensorless rooms doesn't stack up dozens of serial round trips. Output order still follows `asset_ids`.
- `butlr_get_current_occupancy` keeps its gate, since a room with no sensors has no live reading.

### Known limitation
- Traffic is still gated on the current sensor assignment, in this tool and in `butlr_traffic_flow` (which rejects a room with no traffic sensors). A room whose traffic sensors were moved away still reports no traffic history. Tracked in #40.

## [0.6.1] - 2026-08-28

### Fixed
- `butlr_traffic_flow` no longer warns on `installation_status: "UNINSTALLED"`. That field is a provisioning-workflow checkbox — the API sets it to `UNINSTALLED` at sensor creation and nothing in the data pipeline ever reads it — so fleets routinely stream with it never flipped, and the warning fired on healthy, online sensors.
- The replacement offline warning is gated on what it can actually explain: it fires only when every queried traffic sensor is offline (`is_online` by truthiness, matching `butlr_hardware_snapshot` — null/absent counts as offline), the window's total is zero, and the sensor's last heartbeat does not postdate the window (a heartbeat at/after `stop` means the outage began after the queried range, so a zero is real data). The copy names the last-seen time when known and points at `butlr_get_asset_details`, which can see room-less/MAC-less sensors that `butlr_hardware_snapshot` structurally cannot. The room path gets the same warning when all of a room's traffic sensors are offline — a hive outage takes them down together, which is the most confident false zero of all.
- Known limit, documented rather than guessed at: a sensor that was down during the window but reconnected before the query reports online, and a point-in-time heartbeat cannot reveal the historical gap — such windows still return an unqualified count.
- `GET_SENSORS_BY_IDS`/`GET_SENSORS_BY_ROOM_IDS` select `last_heartbeat` (used by the gate above) and drop `installation_status`, which nothing read anymore. `Sensor.is_online` is defensively optional in the client types, same rationale as `mode`.

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
