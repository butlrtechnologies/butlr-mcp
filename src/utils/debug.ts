/**
 * Centralized debug logger. Writes to stderr (required for MCP stdio transport).
 * Only logs when DEBUG=butlr-mcp or DEBUG=*.
 */
export function debug(tag: string, ...args: unknown[]): void {
  if (process.env.DEBUG === "butlr-mcp" || process.env.DEBUG === "*") {
    console.error(`[${tag}]`, ...args);
  }
}
