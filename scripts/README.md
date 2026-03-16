# Test Fixture Generation Scripts

This directory contains scripts for generating test fixtures from live Butlr API responses.

## snapshot-api-responses.ts

Captures real API responses and saves them as JSON fixtures for integration tests.

### Usage

```bash
# Ensure you have valid credentials in .env
npm run fixtures
```

### What It Does

1. **Queries GraphQL API** for topology and device health data
2. **Queries v3 Reporting API** for occupancy and traffic data
3. **Queries v4 Stats API** for statistical aggregations
4. **Sanitizes sensitive data**:
   - Anonymizes organization/site names
   - Masks MAC addresses (keeps format: `AA:11:22:33:44:55`)
   - Replaces serial numbers with test values
5. **Saves to `src/__fixtures__/`**:
   - `graphql/*.json` - GraphQL query responses
   - `reporting/*.json` - v3 Reporting API responses
   - `stats/*.json` - v4 Stats API responses

### Generated Fixtures

**GraphQL:**
- `full-topology-org.json` - Complete org topology with all devices
- `building-device-health.json` - Single building scope
- `floor-device-health.json` - Single floor scope
- `rooms-with-capacity.json` - Rooms with capacity and tags

**Reporting (v3):**
- `current-occupancy-rooms.json` - Current occupancy for sample rooms
- `traffic-flow-hourly.json` - Hourly traffic aggregation
- `traffic-flow-today.json` - Full day traffic data

**Stats (v4):**
- `room-stats-4weeks.json` - 4-week statistics for a single room
- `multi-room-stats.json` - 7-day statistics for multiple rooms

### When to Regenerate Fixtures

Run this script when:
- API response schemas change
- New fields are added to queries
- Test data needs to be refreshed
- Adding new integration test scenarios

### Security Notes

- ⚠️ **Review generated fixtures** before committing to ensure all sensitive data is sanitized
- The script automatically masks MAC addresses and serial numbers
- Organization names are replaced with generic test names
- **Never commit** fixtures with real customer data or PII

### Troubleshooting

**Error: Authentication failed**
- Check `.env` file has valid `BUTLR_CLIENT_ID` and `BUTLR_CLIENT_SECRET`
- Ensure credentials have read access to organization data

**Error: No data returned**
- Verify organization has sensors, hives, and rooms deployed
- Check that API endpoints are accessible

**Error: Failed to load fixture in tests**
- Run `npm run fixtures` to generate missing fixtures
- Check that `src/__fixtures__/` directories exist
