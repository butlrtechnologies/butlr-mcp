import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { debug } from "../utils/debug.js";

/**
 * Wraps a tool handler to catch errors and return them as MCP tool errors
 * with isError: true, so the LLM can see and handle the error.
 */
export function withToolErrorHandling(
  handler: (args: Record<string, unknown>) => Promise<CallToolResult>
): (args: Record<string, unknown>) => Promise<CallToolResult> {
  return async (args) => {
    try {
      return await handler(args);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      debug("tool-error", message, error);
      return {
        content: [{ type: "text" as const, text: message }],
        isError: true,
      };
    }
  };
}

/**
 * Structural type for Apollo-like errors (ApolloError was removed in Apollo Client 4.0)
 * Narrowed from `any` to `unknown` with runtime property checks inside translateGraphQLError.
 */
interface GraphQLClientError {
  networkError?: {
    statusCode?: number;
    message?: string;
    result?: unknown;
    response?: { headers?: { get(name: string): string | null } };
  };
  graphQLErrors?: Array<{
    message: string;
    extensions?: Record<string, unknown>;
  }>;
  message?: string;
}

/**
 * MCP Error Codes
 * Standard error codes for Model Context Protocol
 */
export enum MCPErrorCode {
  AUTH_EXPIRED = "AUTH_EXPIRED",
  RATE_LIMITED = "RATE_LIMITED",
  VALIDATION_FAILED = "VALIDATION_FAILED",
  INTERNAL_ERROR = "INTERNAL_ERROR",
  NOT_FOUND = "NOT_FOUND",
  NETWORK_ERROR = "NETWORK_ERROR",
}

export interface MCPError {
  code: MCPErrorCode;
  message: string;
  details?: Record<string, unknown>;
  retryable?: boolean;
  retryAfter?: number; // seconds
}

/**
 * Translate GraphQL/Apollo errors to MCP error format
 */
export function translateGraphQLError(error: GraphQLClientError): MCPError {
  // Check for network errors
  if (error.networkError) {
    const networkError = error.networkError;

    // Authentication errors
    if (networkError.statusCode === 401 || networkError.statusCode === 403) {
      return {
        code: MCPErrorCode.AUTH_EXPIRED,
        message: "Authentication failed. Please check BUTLR_CLIENT_ID and BUTLR_CLIENT_SECRET.",
        details: {
          statusCode: networkError.statusCode,
        },
        retryable: false,
      };
    }

    // Rate limiting
    if (networkError.statusCode === 429) {
      const retryAfter = parseInt(networkError.response?.headers?.get("retry-after") || "60", 10);
      return {
        code: MCPErrorCode.RATE_LIMITED,
        message: `API rate limit exceeded. Please retry after ${retryAfter} seconds.`,
        retryable: true,
        retryAfter,
      };
    }

    // Bad request / validation
    if (networkError.statusCode === 400) {
      return {
        code: MCPErrorCode.VALIDATION_FAILED,
        message: "Invalid request parameters.",
        details: {
          statusCode: 400,
          body: networkError.result,
        },
        retryable: false,
      };
    }

    // Not found
    if (networkError.statusCode === 404) {
      return {
        code: MCPErrorCode.NOT_FOUND,
        message: "Resource not found.",
        retryable: false,
      };
    }

    // Generic network error
    return {
      code: MCPErrorCode.NETWORK_ERROR,
      message: `Network error: ${networkError.message}`,
      details: {
        statusCode: networkError.statusCode,
      },
      retryable: true,
    };
  }

  // Check for GraphQL errors
  if (error.graphQLErrors && error.graphQLErrors.length > 0) {
    const firstError = error.graphQLErrors[0];

    // Authentication errors
    if (firstError.extensions?.code === "UNAUTHENTICATED") {
      return {
        code: MCPErrorCode.AUTH_EXPIRED,
        message: "JWT token expired or invalid. Re-authenticating...",
        retryable: true,
      };
    }

    // Validation errors
    if (firstError.extensions?.code === "BAD_USER_INPUT") {
      return {
        code: MCPErrorCode.VALIDATION_FAILED,
        message: `Invalid input: ${firstError.message}`,
        details: firstError.extensions,
        retryable: false,
      };
    }

    // Generic GraphQL error
    return {
      code: MCPErrorCode.INTERNAL_ERROR,
      message: firstError.message,
      details: firstError.extensions,
      retryable: false,
    };
  }

  // Fallback: unknown error
  return {
    code: MCPErrorCode.INTERNAL_ERROR,
    message: error.message || "An unknown error occurred",
    retryable: false,
  };
}

/**
 * Format MCP error for user-friendly display
 */
export function formatMCPError(error: MCPError): string {
  let message = `[${error.code}] ${error.message}`;

  if (error.retryable) {
    message += " (retryable)";
  }

  if (error.retryAfter) {
    message += ` - retry after ${error.retryAfter}s`;
  }

  if (error.details && (process.env.DEBUG === "butlr-mcp" || process.env.DEBUG === "*")) {
    message += `\nDetails: ${JSON.stringify(error.details, null, 2)}`;
  }

  return message;
}

/**
 * Throw a properly MCP-formatted INTERNAL_ERROR. Use for upstream contract
 * violations (unexpected response shape, missing data envelope, etc.) so
 * the failure surfaces with a structured `[INTERNAL_ERROR]` prefix that
 * `withToolErrorHandling` translates uniformly. Without this, every tool
 * would have a different error-shape contract for the same class of bug.
 */
export function throwInternalError(message: string): never {
  const mcpError: MCPError = {
    code: MCPErrorCode.INTERNAL_ERROR,
    message,
    retryable: true,
  };
  throw new Error(formatMCPError(mcpError));
}

/**
 * Error subclass for MCP errors — provides stack traces and works with instanceof checks.
 */
export class MCPValidationError extends Error {
  code: MCPErrorCode;
  details?: Record<string, unknown>;
  retryable: boolean;

  constructor(message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "MCPValidationError";
    this.code = MCPErrorCode.VALIDATION_FAILED;
    this.details = details;
    this.retryable = false;
  }
}

/**
 * Create a validation error (throws a proper Error subclass with stack trace)
 */
export function createValidationError(
  message: string,
  details?: Record<string, unknown>
): MCPValidationError {
  return new MCPValidationError(message, details);
}
