import { ApolloClient, InMemoryCache, createHttpLink, from } from "@apollo/client";
import { setContext } from "@apollo/client/link/context";
import { onError } from "@apollo/client/link/error";
import { authClient } from "./auth-client.js";

const BASE_URL = process.env.BUTLR_BASE_URL || "https://api.butlr.io";
const GRAPHQL_ENDPOINT = `${BASE_URL}/api/v3/graphql`;

/**
 * HTTP link for GraphQL endpoint
 */
const httpLink = createHttpLink({
  uri: GRAPHQL_ENDPOINT,
  fetch,
});

/**
 * Authentication link - adds Bearer token to every request
 */
const authLink = setContext(async (_, { headers }) => {
  try {
    const token = await authClient.getToken();
    return {
      headers: {
        ...headers,
        authorization: `Bearer ${token}`,
      },
    };
  } catch (error) {
    console.error("[graphql-client] Failed to get auth token:", error);
    throw error;
  }
});

/**
 * Error handling link - logs errors and provides debugging info
 */
const errorLink = onError(({ error, operation }) => {
  console.error(`[graphql-client] Error in ${operation.operationName}:`, error.message);

  // Clear cached token on auth errors
  if (
    error.message?.includes("UNAUTHENTICATED") ||
    error.message?.includes("401") ||
    error.message?.includes("403")
  ) {
    authClient.clearToken();
  }
});

/**
 * Apollo Client instance with authentication and error handling
 */
export const apolloClient = new ApolloClient({
  link: from([errorLink, authLink, httpLink]),
  cache: new InMemoryCache({
    typePolicies: {
      // Customize caching behavior if needed
      Site: {
        keyFields: ["id"],
      },
      Building: {
        keyFields: ["id"],
      },
      Floor: {
        keyFields: ["id"],
      },
      Room: {
        keyFields: ["id"],
      },
      Zone: {
        keyFields: ["id"],
      },
      Sensor: {
        keyFields: ["id"],
      },
      Hive: {
        keyFields: ["id"],
      },
    },
  }),
  defaultOptions: {
    query: {
      fetchPolicy: "network-only", // Always fetch fresh data from API
      errorPolicy: "all", // Return partial data on errors
    },
  },
});
