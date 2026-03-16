#!/usr/bin/env node
import { Command } from "commander";
import dotenv from "dotenv";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

// Load environment variables from .env file
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Load package.json to get version
 */
function getPackageVersion(): string {
  try {
    const packagePath = resolve(__dirname, "../package.json");
    const packageJson = JSON.parse(readFileSync(packagePath, "utf-8"));
    return packageJson.version;
  } catch (error) {
    console.error("[cli] Failed to read package.json version:", error);
    return "unknown";
  }
}

/**
 * CLI interface for the Butlr MCP Server
 *
 * Configuration via flags or environment variables:
 * - --org-id / BUTLR_ORG_ID: Organization ID
 * - --client-id / BUTLR_CLIENT_ID: OAuth2 Client ID
 * - --client-secret / BUTLR_CLIENT_SECRET: OAuth2 Client Secret
 * - --base-url / BUTLR_BASE_URL: Base URL for Butlr APIs
 * - --cache-ttl / MCP_CACHE_TOPO_TTL: Cache TTL in seconds
 * - --max-ids / MCP_MAX_IDS: Maximum IDs per call
 * - --toolsets / BUTLR_TOOLSETS: Enabled tool groups
 */
const program = new Command();

program
  .name("butlr-mcp")
  .description("Butlr MCP Server - Model Context Protocol adapter for Butlr APIs")
  .version(getPackageVersion())
  .option("--org-id <id>", "Butlr organization ID", process.env.BUTLR_ORG_ID)
  .option("--client-id <id>", "OAuth2 client ID", process.env.BUTLR_CLIENT_ID)
  .option("--client-secret <secret>", "OAuth2 client secret", process.env.BUTLR_CLIENT_SECRET)
  .option(
    "--base-url <url>",
    "Base URL for Butlr APIs",
    process.env.BUTLR_BASE_URL || "https://api.butlr.io"
  )
  .option("--cache-ttl <seconds>", "Cache TTL in seconds", process.env.MCP_CACHE_TOPO_TTL || "600")
  .option("--max-ids <count>", "Maximum IDs per request", process.env.MCP_MAX_IDS || "100")
  .option(
    "--toolsets <groups>",
    "Comma-separated tool groups to enable (e.g., occupancy,topology,devices)",
    process.env.BUTLR_TOOLSETS || "occupancy,topology,devices"
  )
  .action((options) => {
    // Validate required options
    if (!options.clientId) {
      console.error(
        "Error: BUTLR_CLIENT_ID is required. Set it via --client-id flag or BUTLR_CLIENT_ID environment variable."
      );
      process.exit(1);
    }

    if (!options.clientSecret) {
      console.error(
        "Error: BUTLR_CLIENT_SECRET is required. Set it via --client-secret flag or BUTLR_CLIENT_SECRET environment variable."
      );
      process.exit(1);
    }

    if (!options.orgId) {
      console.error(
        "Error: Organization ID is required. Set it via --org-id flag or BUTLR_ORG_ID environment variable."
      );
      process.exit(1);
    }

    // Store validated config in env vars for the server to access
    process.env.BUTLR_CLIENT_ID = options.clientId;
    process.env.BUTLR_CLIENT_SECRET = options.clientSecret;
    process.env.BUTLR_ORG_ID = options.orgId;
    process.env.BUTLR_BASE_URL = options.baseUrl;
    process.env.MCP_CACHE_TOPO_TTL = options.cacheTtl;
    process.env.MCP_MAX_IDS = options.maxIds;
    process.env.BUTLR_TOOLSETS = options.toolsets;

    // Import and start the server
    // Note: In production, this would dynamically import ./index.js
    console.error("CLI parsed successfully. In production, this would start the MCP server.");
    console.error("Configuration:", {
      orgId: options.orgId,
      baseUrl: options.baseUrl,
      cacheTtl: options.cacheTtl,
      maxIds: options.maxIds,
      toolsets: options.toolsets,
    });
  });

program.parse();
