# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
