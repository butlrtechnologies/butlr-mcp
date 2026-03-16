/**
 * Mock utilities for v4 Stats REST API client
 * Used in integration tests to simulate API responses
 */

import { vi } from "vitest";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import type { StatsResponse } from "../clients/stats-client.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Load a stats API fixture file
 */
export function loadStatsFixture(fixtureName: string): StatsResponse {
  const fixturePath = join(__dirname, "../__fixtures__/stats", `${fixtureName}.json`);

  try {
    const content = readFileSync(fixturePath, "utf-8");
    return JSON.parse(content);
  } catch (error: any) {
    throw new Error(
      `Failed to load Stats fixture '${fixtureName}': ${error.message}\n` +
        `Expected path: ${fixturePath}\n` +
        `Hint: Run 'npm run fixtures' to generate test fixtures.`
    );
  }
}

/**
 * Create a mock stats query function that returns fixture data
 */
export function mockStatsResponse(fixtureName: string) {
  const fixture = loadStatsFixture(fixtureName);
  return vi.fn().mockResolvedValue(fixture);
}

/**
 * Create a mock stats query that returns an error
 */
export function mockStatsError(statusCode: number, message: string) {
  const error = new Error(`Stats API error (${statusCode}): ${message}`);
  return vi.fn().mockRejectedValue(error);
}

/**
 * Create a mock for 504 Gateway Timeout (stats service overloaded)
 */
export function mockStatsTimeout() {
  return mockStatsError(
    504,
    "Stats service temporarily unavailable (504). Try reducing the time range or number of assets."
  );
}

/**
 * Create a mock for authentication errors
 */
export function mockStatsAuthError() {
  return mockStatsError(401, "Unauthorized");
}

/**
 * Create a mock that returns empty stats
 */
export function mockStatsEmpty(assetIds: string[]) {
  const emptyData: Record<string, any> = {};

  assetIds.forEach((id) => {
    emptyData[id] = {
      count: 0,
      first: 0,
      last: 0,
      max: 0,
      mean: 0,
      median: 0,
      min: 0,
      stdev: 0,
      sum: 0,
    };
  });

  return vi.fn().mockResolvedValue({
    data: emptyData,
  });
}

/**
 * Create custom stats response for testing
 */
export function mockStatsCustom(customData: Record<string, any>) {
  return vi.fn().mockResolvedValue({
    data: customData,
  });
}
