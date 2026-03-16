import { describe, it, expect } from "vitest";
import {
  translateGraphQLError,
  formatMCPError,
  createValidationError,
  MCPValidationError,
  MCPErrorCode,
} from "./mcp-errors.js";

describe("translateGraphQLError", () => {
  it("translates 401 network error to AUTH_EXPIRED", () => {
    const error = { networkError: { statusCode: 401, message: "Unauthorized" } };
    const result = translateGraphQLError(error);
    expect(result.code).toBe(MCPErrorCode.AUTH_EXPIRED);
    expect(result.retryable).toBe(false);
  });

  it("translates 403 network error to AUTH_EXPIRED", () => {
    const error = { networkError: { statusCode: 403, message: "Forbidden" } };
    const result = translateGraphQLError(error);
    expect(result.code).toBe(MCPErrorCode.AUTH_EXPIRED);
  });

  it("translates 429 network error to RATE_LIMITED with retry-after", () => {
    const error = {
      networkError: {
        statusCode: 429,
        message: "Too Many Requests",
        response: { headers: { get: () => "30" } },
      },
    };
    const result = translateGraphQLError(error);
    expect(result.code).toBe(MCPErrorCode.RATE_LIMITED);
    expect(result.retryable).toBe(true);
    expect(result.retryAfter).toBe(30);
  });

  it("defaults retry-after to 60 when header is missing", () => {
    const error = {
      networkError: { statusCode: 429, message: "Too Many Requests" },
    };
    const result = translateGraphQLError(error);
    expect(result.retryAfter).toBe(60);
  });

  it("translates 400 network error to VALIDATION_FAILED", () => {
    const error = { networkError: { statusCode: 400, message: "Bad Request" } };
    const result = translateGraphQLError(error);
    expect(result.code).toBe(MCPErrorCode.VALIDATION_FAILED);
    expect(result.retryable).toBe(false);
  });

  it("translates 404 network error to NOT_FOUND", () => {
    const error = { networkError: { statusCode: 404, message: "Not Found" } };
    const result = translateGraphQLError(error);
    expect(result.code).toBe(MCPErrorCode.NOT_FOUND);
  });

  it("translates generic network error to NETWORK_ERROR", () => {
    const error = { networkError: { statusCode: 500, message: "Internal Server Error" } };
    const result = translateGraphQLError(error);
    expect(result.code).toBe(MCPErrorCode.NETWORK_ERROR);
    expect(result.retryable).toBe(true);
  });

  it("translates UNAUTHENTICATED GraphQL error to AUTH_EXPIRED", () => {
    const error = {
      graphQLErrors: [{ message: "Not authenticated", extensions: { code: "UNAUTHENTICATED" } }],
    };
    const result = translateGraphQLError(error);
    expect(result.code).toBe(MCPErrorCode.AUTH_EXPIRED);
    expect(result.retryable).toBe(true);
  });

  it("translates BAD_USER_INPUT GraphQL error to VALIDATION_FAILED", () => {
    const error = {
      graphQLErrors: [{ message: "Invalid ID format", extensions: { code: "BAD_USER_INPUT" } }],
    };
    const result = translateGraphQLError(error);
    expect(result.code).toBe(MCPErrorCode.VALIDATION_FAILED);
    expect(result.message).toContain("Invalid ID format");
  });

  it("translates generic GraphQL error to INTERNAL_ERROR", () => {
    const error = {
      graphQLErrors: [{ message: "Something went wrong" }],
    };
    const result = translateGraphQLError(error);
    expect(result.code).toBe(MCPErrorCode.INTERNAL_ERROR);
  });

  it("handles unknown errors with fallback", () => {
    const error = { message: "Mystery error" };
    const result = translateGraphQLError(error);
    expect(result.code).toBe(MCPErrorCode.INTERNAL_ERROR);
    expect(result.message).toBe("Mystery error");
  });

  it("handles completely empty error", () => {
    const result = translateGraphQLError({});
    expect(result.code).toBe(MCPErrorCode.INTERNAL_ERROR);
    expect(result.message).toBe("An unknown error occurred");
  });
});

describe("formatMCPError", () => {
  it("formats basic error", () => {
    const error = { code: MCPErrorCode.NOT_FOUND, message: "Resource not found", retryable: false };
    expect(formatMCPError(error)).toBe("[NOT_FOUND] Resource not found");
  });

  it("includes retryable flag", () => {
    const error = { code: MCPErrorCode.NETWORK_ERROR, message: "Timeout", retryable: true };
    expect(formatMCPError(error)).toContain("(retryable)");
  });

  it("includes retry-after", () => {
    const error = {
      code: MCPErrorCode.RATE_LIMITED,
      message: "Rate limited",
      retryable: true,
      retryAfter: 30,
    };
    expect(formatMCPError(error)).toContain("retry after 30s");
  });
});

describe("createValidationError", () => {
  it("creates error with correct code", () => {
    const error = createValidationError("bad input");
    expect(error.code).toBe(MCPErrorCode.VALIDATION_FAILED);
    expect(error.message).toBe("bad input");
    expect(error.retryable).toBe(false);
  });

  it("includes details when provided", () => {
    const error = createValidationError("bad input", { field: "query" });
    expect(error.details).toEqual({ field: "query" });
  });

  it("is an instance of Error", () => {
    const error = createValidationError("bad input");
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(MCPValidationError);
  });

  it("has a stack trace", () => {
    const error = createValidationError("bad input");
    expect(error.stack).toBeDefined();
  });

  it("works with instanceof in catch blocks", () => {
    try {
      throw createValidationError("test error");
    } catch (e) {
      expect(e instanceof Error).toBe(true);
      expect(e instanceof MCPValidationError).toBe(true);
    }
  });
});
