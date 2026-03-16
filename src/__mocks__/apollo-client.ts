/**
 * Mock utilities for Apollo GraphQL client
 * Used in integration tests to simulate API responses
 */

import { vi } from "vitest";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Load a GraphQL fixture file
 */
export function loadGraphQLFixture(fixtureName: string): any {
  const fixturePath = join(__dirname, "../__fixtures__/graphql", `${fixtureName}.json`);

  try {
    const content = readFileSync(fixturePath, "utf-8");
    return JSON.parse(content);
  } catch (error: any) {
    throw new Error(
      `Failed to load GraphQL fixture '${fixtureName}': ${error.message}\n` +
        `Expected path: ${fixturePath}\n` +
        `Hint: Run 'npm run fixtures' to generate test fixtures.`
    );
  }
}

/**
 * Create a mock GraphQL query function that returns fixture data
 */
export function mockGraphQLQuery(fixtureName: string) {
  const fixture = loadGraphQLFixture(fixtureName);

  return vi.fn().mockResolvedValue({
    data: fixture,
    loading: false,
    networkStatus: 7,
  });
}

/**
 * Create a mock GraphQL query that returns errors
 */
export function mockGraphQLError(statusCode: number, message: string) {
  return vi.fn().mockRejectedValue({
    networkError: {
      statusCode,
      message,
      result: {
        errors: [{ message }],
      },
    },
  });
}

/**
 * Create a mock for GraphQL validation errors
 */
export function mockGraphQLValidationError(fieldErrors: Record<string, string>) {
  return vi.fn().mockRejectedValue({
    graphQLErrors: Object.entries(fieldErrors).map(([field, message]) => ({
      message,
      extensions: {
        code: "VALIDATION_ERROR",
        field,
      },
    })),
  });
}

/**
 * Mock Apollo client with custom query implementation
 */
export function createMockApolloClient(queryFn: any) {
  return {
    query: queryFn,
    mutate: vi.fn(),
    watchQuery: vi.fn(),
    subscribe: vi.fn(),
    readQuery: vi.fn(),
    readFragment: vi.fn(),
    writeQuery: vi.fn(),
    writeFragment: vi.fn(),
    resetStore: vi.fn(),
    clearStore: vi.fn(),
    onResetStore: vi.fn(),
    onClearStore: vi.fn(),
    stop: vi.fn(),
    reFetchObservableQueries: vi.fn(),
  };
}
