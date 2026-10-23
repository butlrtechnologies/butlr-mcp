import { describe, it, expect, vi, afterEach } from "vitest";
import { parseHistoryEndTtlSeconds } from "./history-end-cache.js";

describe("MCP_CACHE_HISTORY_END_TTL", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("defaults to 10 minutes when unset or empty", () => {
    expect(parseHistoryEndTtlSeconds(undefined)).toBe(600);
    expect(parseHistoryEndTtlSeconds("  ")).toBe(600);
  });

  it("accepts a non-negative number of seconds, 0 included", () => {
    expect(parseHistoryEndTtlSeconds("30")).toBe(30);
    expect(parseHistoryEndTtlSeconds("0")).toBe(0);
  });

  it("falls back to the default with a warning for a value that is not a number", () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(parseHistoryEndTtlSeconds("ten")).toBe(600);
    expect(parseHistoryEndTtlSeconds("-5")).toBe(600);
    expect(parseHistoryEndTtlSeconds("NaN")).toBe(600);
    expect(warn).toHaveBeenCalledTimes(3);
    expect(warn.mock.calls[0][0]).toMatch(/Ignoring invalid MCP_CACHE_HISTORY_END_TTL="ten"/);
  });

  it("0 turns caching off instead of caching forever", async () => {
    vi.stubEnv("MCP_CACHE_HISTORY_END_TTL", "0");
    vi.resetModules();
    const cache = await import("./history-end-cache.js");
    cache.setCachedHistoryEnd("room_1", "UTC|", "2026-10-20");
    expect(cache.getCachedHistoryEnd("room_1", "UTC|")).toBeUndefined();
  });

  it("caches by default", async () => {
    vi.resetModules();
    const cache = await import("./history-end-cache.js");
    cache.setCachedHistoryEnd("room_1", "UTC|", "2026-10-20");
    expect(cache.getCachedHistoryEnd("room_1", "UTC|")).toEqual({ endDay: "2026-10-20" });
  });
});
