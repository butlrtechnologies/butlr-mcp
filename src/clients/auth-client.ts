import dotenv from "dotenv";

dotenv.config();

const BASE_URL = process.env.BUTLR_BASE_URL || "https://api.butlr.io";
const AUTH_ENDPOINT = `${BASE_URL}/api/v2/clients/login`;

interface TokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
}

/**
 * Butlr Authentication Client
 * Manages OAuth2 client credentials flow for API authentication
 */
class ButlrAuthClient {
  private token: string | null = null;
  private tokenExpiry: Date | null = null;
  private readonly clientId: string;
  private readonly clientSecret: string;

  constructor() {
    this.clientId = process.env.BUTLR_CLIENT_ID || "";
    this.clientSecret = process.env.BUTLR_CLIENT_SECRET || "";
  }

  /**
   * Get a valid access token, fetching a new one if needed
   */
  async getToken(): Promise<string> {
    // Validate credentials on first use (deferred from constructor)
    if (!this.clientId || !this.clientSecret) {
      throw new Error(
        "BUTLR_CLIENT_ID and BUTLR_CLIENT_SECRET environment variables are required. " +
          "See README.md for configuration instructions."
      );
    }

    // Return cached token if still valid (with 5 minute buffer)
    if (this.token && this.tokenExpiry && Date.now() < this.tokenExpiry.getTime() - 5 * 60 * 1000) {
      if (process.env.DEBUG) {
        console.error("[auth-client] Using cached token");
      }
      return this.token;
    }

    if (process.env.DEBUG) {
      console.error("[auth-client] Fetching new token...");
    }

    // Fetch new token
    try {
      const response = await fetch(AUTH_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          client_id: this.clientId,
          client_secret: this.clientSecret,
          audience: "https://butlrauth/",
          grant_type: "client_credentials",
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Authentication failed (${response.status}): ${errorText}`);
      }

      const data = (await response.json()) as TokenResponse;

      if (!data.access_token) {
        throw new Error("No access_token in response");
      }

      // Cache the token
      this.token = data.access_token;
      this.tokenExpiry = new Date(Date.now() + data.expires_in * 1000);

      if (process.env.DEBUG) {
        console.error(`[auth-client] Token acquired, expires at ${this.tokenExpiry.toISOString()}`);
      }

      return this.token;
    } catch (error) {
      console.error("[auth-client] Token fetch failed:", error);
      throw new Error(
        `Failed to authenticate with Butlr API: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Clear cached token (useful for testing)
   */
  clearToken(): void {
    this.token = null;
    this.tokenExpiry = null;
  }
}

// Singleton instance
export const authClient = new ButlrAuthClient();
