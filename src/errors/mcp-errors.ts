// Using any for Apollo error due to type export issues
type ApolloError = any;

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
  details?: Record<string, any>;
  retryable?: boolean;
  retryAfter?: number; // seconds
}

/**
 * Translate GraphQL/Apollo errors to MCP error format
 */
export function translateGraphQLError(error: ApolloError): MCPError {
  // Check for network errors
  if (error.networkError) {
    const networkError = error.networkError as any;

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

  if (error.details && process.env.DEBUG) {
    message += `\nDetails: ${JSON.stringify(error.details, null, 2)}`;
  }

  return message;
}

/**
 * Create a validation error
 */
export function createValidationError(message: string, details?: Record<string, any>): MCPError {
  return {
    code: MCPErrorCode.VALIDATION_FAILED,
    message,
    details,
    retryable: false,
  };
}
