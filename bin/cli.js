#!/usr/bin/env node

/**
 * CLI entry point for Butlr MCP Server
 *
 * This wrapper allows the package to be run via `npx @butlr/butlr-mcp-server`
 * or installed globally as `butlr-mcp`.
 *
 * During development, TypeScript files are executed directly via tsx.
 * In production, this imports the compiled JavaScript from dist/.
 */

import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Check if we're running in development (src/ exists) or production (dist/ exists)
const isDevelopment = process.env.NODE_ENV !== "production";

if (isDevelopment) {
  // Development: run TypeScript directly with tsx
  const { spawn } = await import("child_process");
  const indexPath = resolve(__dirname, "../src/index.ts");

  const child = spawn("npx", ["tsx", indexPath], {
    stdio: "inherit",
    env: process.env,
  });

  child.on("exit", (code) => {
    process.exit(code || 0);
  });
} else {
  // Production: import compiled JavaScript
  await import("../dist/index.js");
}
