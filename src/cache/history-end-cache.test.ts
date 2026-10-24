import { describe, it, expect, vi, afterEach } from "vitest";
import { parseTtlSeconds } from "./ttl.js";

const parseHistoryEndTtlSeconds = (raw: string | undefined) =>
  parseTtlSeconds("MCP_CACHE_HISTORY_END_TTL", raw, 600);

const END = { endDay: "2026-10-20", windowStart: "2026-04-29" };

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

  it("accepts whole non-negative seconds, 0 included", () => {
    expect(parseHistoryEndTtlSeconds("30")).toBe(30);
    expect(parseHistoryEndTtlSeconds("0")).toBe(0);
  });

  it("rejects fractions, which lru-cache would refuse at import", () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => undefined);
    for (const raw of ["16.1", "2.01", "0.0001", "1e306"]) {
      expect(parseHistoryEndTtlSeconds(raw)).toBe(600);
    }
    expect(warn).toHaveBeenCalledTimes(4);
  });

  it("starts with a fractional TTL in the environment instead of throwing at import", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubEnv("MCP_CACHE_HISTORY_END_TTL", "16.1");
    vi.resetModules();
    const cache = await import("./history-end-cache.js");
    cache.setCachedHistoryEnd("room_1", "UTC|", END);
    expect(cache.getCachedHistoryEnd("room_1", "UTC|")).toEqual(END);
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
    cache.setCachedHistoryEnd("room_1", "UTC|", END);
    expect(cache.getCachedHistoryEnd("room_1", "UTC|")).toBeUndefined();
  });

  it("caches by default", async () => {
    vi.resetModules();
    const cache = await import("./history-end-cache.js");
    cache.setCachedHistoryEnd("room_1", "UTC|", END);
    expect(cache.getCachedHistoryEnd("room_1", "UTC|")).toEqual(END);
  });
});
