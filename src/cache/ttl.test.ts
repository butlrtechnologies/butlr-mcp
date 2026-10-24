import { describe, it, expect, vi, afterEach } from "vitest";
import { parseTtlSeconds } from "./ttl.js";

describe("cache TTL environment variables", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("parses whole seconds and falls back with a warning otherwise", () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(parseTtlSeconds("X", undefined, 600)).toBe(600);
    expect(parseTtlSeconds("X", "30", 600)).toBe(30);
    expect(parseTtlSeconds("X", "0", 600)).toBe(0);
    for (const raw of ["abc", "-1", "16.1", "NaN", "1e306"]) {
      expect(parseTtlSeconds("X", raw, 600)).toBe(600);
    }
    expect(warn).toHaveBeenCalledTimes(5);
  });

  it("MCP_CACHE_TOPO_TTL=0 disables the topology cache instead of caching forever", async () => {
    vi.stubEnv("MCP_CACHE_TOPO_TTL", "0");
    const cache = await import("./topology-cache.js");
    cache.setCachedTopology("k", { sites: [] });
    expect(cache.getCachedTopology("k")).toBeUndefined();
  });

  it("MCP_CACHE_TOPO_TTL=-1 or abc starts with the default instead of crashing at import", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    for (const raw of ["-1", "abc"]) {
      vi.stubEnv("MCP_CACHE_TOPO_TTL", raw);
      vi.resetModules();
      const cache = await import("./topology-cache.js");
      cache.setCachedTopology("k", { sites: [] });
      expect(cache.getCachedTopology("k")).toBeDefined();
      expect(cache.getCacheStats().ttl).toBe(600);
    }
  });

  it("MCP_CACHE_OCCUPANCY_TTL=0 disables the occupancy cache", async () => {
    vi.stubEnv("MCP_CACHE_OCCUPANCY_TTL", "0");
    const cache = await import("./occupancy-cache.js");
    const now = new Date();
    cache.setCachedOccupancy("room_1", 3, "room", now);
    expect(cache.getCachedOccupancy("room_1", now)).toBeUndefined();
  });
});
