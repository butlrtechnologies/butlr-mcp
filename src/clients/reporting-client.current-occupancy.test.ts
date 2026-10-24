import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ApiError, getCurrentOccupancy } from "./reporting-client.js";

vi.mock("./auth-client.js", () => ({
  authClient: { getToken: vi.fn(async () => "token"), clearToken: vi.fn() },
}));

/** Stub fetch: presence (room_occupancy) and traffic answer independently. */
function stubReporting(
  presence: Response | (() => Response),
  traffic: Response | (() => Response)
) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as { filter: { measurements: string[] } };
      const answer = body.filter.measurements[0].startsWith("traffic") ? traffic : presence;
      return typeof answer === "function" ? answer() : answer.clone();
    })
  );
}

const json = (data: unknown) =>
  new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

describe("getCurrentOccupancy: a failed presence query is not 0 people", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  for (const status of [401, 429, 500]) {
    it(`surfaces a presence ${status} instead of an empty result`, async () => {
      stubReporting(new Response("nope", { status }), new Response("nope", { status }));
      await expect(getCurrentOccupancy("room", ["room_1"])).rejects.toMatchObject({
        statusCode: status,
      });
    });
  }

  it("surfaces a presence failure when traffic has no rows to fall back on", async () => {
    stubReporting(new Response("nope", { status: 500 }), json({}));
    await expect(getCurrentOccupancy("room", ["room_1"])).rejects.toBeInstanceOf(ApiError);
  });

  it("falls back to traffic when presence fails but traffic has readings", async () => {
    stubReporting(
      new Response("nope", { status: 500 }),
      json({ room_1: { "2026-10-23T12:00:00Z": { median: 3 } } })
    );
    const points = await getCurrentOccupancy("room", ["room_1"]);
    expect(points.map((p) => p.asset_id)).toEqual(["room_1"]);
  });
});
