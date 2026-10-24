import { beforeEach, vi } from "vitest";
import { primeSpaceFieldSupport } from "../clients/space-field-support.js";

// Reset all mocks before each test, and treat the API as supporting every
// optional Room/Zone field (archive-fields.ts) so no test has to mock the
// schema check. Tests of the check itself reset this.
beforeEach(() => {
  vi.clearAllMocks();
  primeSpaceFieldSupport();
});

// Mock environment variables for tests
process.env.BUTLR_CLIENT_ID = "test-client-id";
process.env.BUTLR_CLIENT_SECRET = "test-client-secret";
process.env.BUTLR_ORG_ID = "org_test123";
process.env.BUTLR_BASE_URL = "https://api.butlr.io";

// Disable debug logging during tests unless explicitly enabled
if (!process.env.DEBUG) {
  process.env.DEBUG = "";
}

// Set timezone to UTC for consistent date/time tests
process.env.TZ = "UTC";
