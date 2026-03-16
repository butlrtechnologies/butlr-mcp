import { beforeEach, vi } from "vitest";

// Reset all mocks before each test
beforeEach(() => {
  vi.clearAllMocks();
});

// Mock environment variables for tests
// These prevent tests from requiring real credentials
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
