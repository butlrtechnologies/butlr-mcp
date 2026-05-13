import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { debug } from "../utils/debug.js";

/**
 * Wraps a tool handler to catch errors and return them as MCP tool errors
 * with isError: true, so the LLM can see and handle the error.
 *
 * If the underlying error message already carries a `[CODE]` prefix
 * (added by `formatMCPError` upstream), the message passes through. If
 * it doesn't — non-Apollo Error classes, unrelated `throw new Error(...)`
 * sites, ServerParseError, etc. — we wrap with an INTERNAL_ERROR prefix
 * so consumers branching on `[XXX]` still see a structured code. Stack
 * traces survive in the `debug` log but never reach the response body.
 */
export function withToolErrorHandling(
  handler: (args: Record<string, unknown>) => Promise<CallToolResult>
): (args: Record<string, unknown>) => Promise<CallToolResult> {
  return async (args) => {
    try {
      return await handler(args);
    } catch (error: unknown) {
      const rawMessage = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : undefined;
      debug("tool-error", rawMessage, stack ?? error);
      // Already-translated errors carry the `[CODE]` prefix; preserve them.
      const text = /^\[[A-Z_]+\]/.test(rawMessage)
        ? rawMessage
        : formatMCPError({
            code: MCPErrorCode.INTERNAL_ERROR,
            message: rawMessage || "Unknown internal error",
            retryable: false,
          });
      return {
        content: [{ type: "text" as const, text }],
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

    // Bad request / validation. Surface the upstream message in the
    // user-visible string so an LLM caller debugging a 400 doesn't have
    // to wait for DEBUG=butlr-mcp to see "Unknown tag id: foo_bar". Fall
    // back to the generic phrasing only when no message can be extracted.
    if (networkError.statusCode === 400) {
      const body = networkError.result as { errors?: Array<{ message?: unknown }> } | undefined;
      const upstreamMessage =
        body?.errors?.find((e) => typeof e?.message === "string")?.message ??
        (typeof networkError.message === "string" ? networkError.message : undefined);
      const truncate = (s: string): string => (s.length > 240 ? `${s.slice(0, 240)}…` : s);
      return {
        code: MCPErrorCode.VALIDATION_FAILED,
        message: upstreamMessage
          ? `Invalid request: ${truncate(String(upstreamMessage))}`
          : "Invalid request parameters.",
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
 * Validate that an upstream-supplied value is array-shaped, returning the
 * array (treating `null`/`undefined` as a legitimately-empty signal) or
 * throwing INTERNAL_ERROR for any other shape. Centralizes the pattern
 * that callers like `butlr_list_topology` / `butlr_list_tags` /
 * `butlr_available_rooms` use on nested response fields where a
 * `value || []` would otherwise launder a contract regression into
 * silently-empty results.
 *
 * Pass `fieldName` for a useful error message; the lenient null/undefined
 * branch reflects that legitimately-empty lists arrive as
 * `[]`/`null`/missing depending on upstream resolver.
 */
export function ensureArrayOrEmpty<T>(
  value: ReadonlyArray<T> | null | undefined | unknown,
  fieldName: string
): ReadonlyArray<T> {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value as ReadonlyArray<T>;
  throwInternalError(
    `Unexpected response shape from ${fieldName} (expected array, got ${typeof value}). ` +
      "Please retry; if persistent, the upstream API contract may have changed."
  );
}

/**
 * Throw a properly MCP-formatted INTERNAL_ERROR. Use for upstream contract
 * violations (unexpected response shape, missing data envelope, etc.) so
 * the failure surfaces with a structured `[INTERNAL_ERROR]` prefix that
 * `withToolErrorHandling` translates uniformly. Without this, every tool
 * would have a different error-shape contract for the same class of bug.
 *
 * `retryable: false` — contract violations are not transient. If the
 * upstream returned a non-array where an array was contracted, retrying
 * will yield the same broken response. MCP clients that auto-retry
 * `retryable: true` errors would spin against this signal otherwise.
 */
export function throwInternalError(message: string): never {
  const mcpError: MCPError = {
    code: MCPErrorCode.INTERNAL_ERROR,
    message,
    retryable: false,
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
