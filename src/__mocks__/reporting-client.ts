/**
 * Mock utilities for v3 Reporting REST API client
 * Used in integration tests to simulate API responses
 */

import { vi } from "vitest";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import type { ReportingResponse } from "../clients/reporting-client.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Load a reporting API fixture file
 */
export function loadReportingFixture(fixtureName: string): ReportingResponse {
  const fixturePath = join(__dirname, "../__fixtures__/reporting", `${fixtureName}.json`);

  try {
    const content = readFileSync(fixturePath, "utf-8");
    return JSON.parse(content);
  } catch (error: any) {
    throw new Error(
      `Failed to load Reporting fixture '${fixtureName}': ${error.message}\n` +
        `Expected path: ${fixturePath}\n` +
        `Hint: Run 'npm run fixtures' to generate test fixtures.`
    );
  }
}

/**
 * Create a mock reporting query function that returns fixture data
 */
export function mockReportingResponse(fixtureName: string) {
  const fixture = loadReportingFixture(fixtureName);
  return vi.fn().mockResolvedValue(fixture);
}

/**
 * Create a mock reporting query that returns an error
 */
export function mockReportingError(statusCode: number, message: string) {
  const error = new Error(`Reporting API error (${statusCode}): ${message}`);
  return vi.fn().mockRejectedValue(error);
}

/**
 * Create a mock for rate limiting
 */
export function mockReportingRateLimit() {
  return mockReportingError(429, "Rate limit exceeded");
}

/**
 * Create a mock for authentication errors
 */
export function mockReportingAuthError() {
  return mockReportingError(401, "Unauthorized");
}

/**
 * Create a mock that returns empty data
 */
export function mockReportingEmpty() {
  return vi.fn().mockResolvedValue({
    data: [],
    page_info: {
      page: 1,
      page_item_count: 0,
      total_item_count: 0,
      total_pages: 0,
    },
  });
}
