# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2025-10-15

### Added

**MCP Tools (10 active, 4 legacy disabled):**
- 4 conversational tools: `butlr_hardware_snapshot`, `butlr_available_rooms`, `butlr_space_busyness`, `butlr_traffic_flow`
- 2 data tools: `search_assets`, `get_asset_details`
- 4 foundation tools: `butlr_list_topology`, `butlr_fetch_entity_details`, `butlr_get_occupancy_timeseries`, `butlr_get_current_occupancy`
- 4 legacy tools (disabled, replaced by unified occupancy tools): `butlr_fetch_traffic_occupancy_timeseries`, `butlr_fetch_presence_occupancy_timeseries`, `butlr_fetch_current_traffic_occupancy`, `butlr_fetch_current_presence_occupancy`

**Infrastructure:**
- v3 GraphQL client with Apollo Client (topology, device inventory)
- v3 REST client with Undici (occupancy timeseries via Reporting API)
- OAuth2 authentication with automatic token refresh
- Smart caching with LRU cache (topology: 10-minute TTL, occupancy: 60-second TTL)
- Response normalization (ISO-8601 timestamps, consistent field naming)
- MCP error translation (AUTH_EXPIRED, RATE_LIMITED, VALIDATION_FAILED)

**Developer Experience:**
- Comprehensive test suite (256 tests, 100% pass rate)
- Timezone-independent tests (verified UTC, Asia/Tokyo, Europe/London)
- Deterministic mocks with explicit timezone handling
- Full integration test coverage for all tools
- ESLint v9 flat config with TypeScript rules
- Prettier code formatting
- Pre-commit hooks with multi-layer protection

**Pre-Commit Protections:**
- TypeScript type checking (`tsc --noEmit`)
- Full test suite execution (~600ms runtime)
- Secret file detection (`.env`, `.pem`, `.key`, `.p12`, `.pfx`)
- Secret pattern scanning (AWS keys, API tokens, JWTs)
- Large file detection (500KB limit with `__fixtures__/` whitelist)
- Auto-format with ESLint + Prettier via lint-staged
- Husky for repo-friendly hook management

**Documentation:**
- Complete MCP tool specifications (`docs/MCP_TOOLS_DESIGN.md`)
- API constraints documentation (`docs/API_CONSTRAINTS.md`)
- GraphQL discovery notes (`docs/GRAPHQL_DISCOVERY.md`)
- Reporting API discovery notes (`docs/REPORTING_API_DISCOVERY.md`)
- User stories and use cases (`docs/USER_STORIES.md`)
- Contributing guidelines (`CONTRIBUTING.md`)
- Vision document with architecture (`VISION.md`)
- Agent instructions (`CLAUDE.md`)
- MCP protocol patterns and misconceptions (`docs/architecture/mcp-patterns.md`)
- Slackbot integration architecture (`docs/integrations/slackbot.md`)
- Chart/CSV/PDF generation architecture (`docs/features/chart-generation.md`)
- Conversation memory and session management (`docs/features/conversation-memory.md`)

### Fixed
- Traffic-flow integration tests now timezone-independent with deterministic mocks
- Hardware-snapshot tests properly mock all three GraphQL queries (topology, sensors, hives)
- Offline device sort order corrected (shortest offline duration first)
- ESLint configuration updated for v9 flat config format
- Test file glob patterns aligned with lint-staged configuration

### Quality Metrics
- **Test Coverage:** 256 tests passing (100% pass rate)
- **Test Performance:** ~600ms for full suite (well under 2s threshold)
- **Code Quality:** 0 ESLint errors, 161 warnings (mostly `any` types in mocks)
- **Security:** Multi-layer secret detection + file size limits
- **Determinism:** All tests pass in any timezone environment

### Known Limitations
- CLI entry point incomplete (bin/cli.js checks NODE_ENV but doesn't start server)
- Large fixture excluded from git (`current-occupancy-presence.json` 2MB)
- Auth model uses client credentials (docs specify long-lived token - needs alignment)
- 4 remaining conversational tools not yet implemented (summary, top_used, usage_trend, insights)

---

[1.0.0]: https://github.com/butlrtechnologies/butlr-mcp/releases/tag/1.0.0
