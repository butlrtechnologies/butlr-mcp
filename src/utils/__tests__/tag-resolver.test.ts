import { describe, it, expect } from "vitest";
import { projectValidRefs, resolveTagNames } from "../tag-resolver.js";
import { asTagId, asTagName } from "../../clients/queries/tags.js";

interface TagRow {
  id: string;
  name: string;
}

const allTags: TagRow[] = [
  { id: "tag_a", name: "huddle" },
  { id: "tag_b", name: "VideoConf" },
  { id: "tag_c", name: "focus" },
];

describe("resolveTagNames", () => {
  it("matches tag names case-insensitively", () => {
    const result = resolveTagNames({
      allTags,
      requestedNames: ["HUDDLE", "videoconf"],
      match: "any",
    });

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return; // type narrowing for the rest of the test
    expect(result.resolvedIds).toEqual(["tag_a", "tag_b"]);
    expect(result.unknownNames).toEqual([]);
    expect(result.droppedRowCount).toBe(0);
  });

  it("collects unknown names without dropping them", () => {
    const result = resolveTagNames({
      allTags,
      requestedNames: ["huddle", "does-not-exist"],
      match: "any",
    });

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.resolvedIds).toEqual(["tag_a"]);
    expect(result.unknownNames).toEqual(["does-not-exist"]);
  });

  it("returns unsatisfiable variant when match='all' has at least one resolved AND one unknown", () => {
    const result = resolveTagNames({
      allTags,
      requestedNames: ["huddle", "does-not-exist"],
      match: "all",
    });

    expect(result.kind).toBe("unsatisfiable");
    if (result.kind !== "unsatisfiable") return;
    expect(result.unknownNames).toEqual(["does-not-exist"]);
    expect(result.partialResolvedCount).toBe(1);
    // The discriminated union prevents reading resolvedIds on the
    // unsatisfiable branch — caller MUST short-circuit.
  });

  it("returns no_match variant (not unsatisfiable) when every requested name is unknown under match='all'", () => {
    const result = resolveTagNames({
      allTags,
      requestedNames: ["does-not-exist"],
      match: "all",
    });

    // All-unknown is its own state — the right diagnostic is "no matching
    // tags found" rather than "cannot satisfy AND" (with one input there's
    // no AND to fail).
    expect(result.kind).toBe("no_match");
    if (result.kind !== "no_match") return;
    expect(result.unknownNames).toEqual(["does-not-exist"]);
  });

  it("returns no_match when every requested name is unknown under match='any'", () => {
    const result = resolveTagNames({
      allTags,
      requestedNames: ["does-not-exist", "also-not"],
      match: "any",
    });

    expect(result.kind).toBe("no_match");
    if (result.kind !== "no_match") return;
    expect(result.unknownNames).toEqual(["does-not-exist", "also-not"]);
  });

  it("returns ok variant when match='all' and every name resolves", () => {
    const result = resolveTagNames({
      allTags,
      requestedNames: ["huddle", "focus"],
      match: "all",
    });

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.resolvedIds).toEqual(["tag_a", "tag_c"]);
  });

  it("preserves the input row shape so callers retain typing", () => {
    interface RichRow extends TagRow {
      organization_id: string;
    }
    const richRows: RichRow[] = [{ id: "tag_a", name: "huddle", organization_id: "org_1" }];

    const result = resolveTagNames({
      allTags: richRows,
      requestedNames: ["huddle"],
      match: "any",
    });

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.resolvedRows[0].organization_id).toBe("org_1");
  });

  it("returns empty arrays when no requested names are supplied", () => {
    const result = resolveTagNames({
      allTags,
      requestedNames: [],
      match: "any",
    });

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.resolvedIds).toEqual([]);
    expect(result.unknownNames).toEqual([]);
  });

  // A tag row missing a usable `name` or `id` previously could crash
  // (.toLowerCase() on null) or surface a null branded TagId downstream.
  // Now both are filtered defensively, AND the count is returned so
  // callers can surface the upstream contract violation as a diagnostic
  // instead of misreporting the user's input as "unknown tag".
  it("skips tag rows missing a usable name or id and reports droppedRowCount", () => {
    const dirty = [
      { id: "tag_a", name: "huddle" },
      { id: "tag_x", name: null as unknown as string }, // null name
      { id: "tag_y" } as unknown as { id: string; name: string }, // missing name
      { id: "tag_z", name: "" }, // empty name
      { id: null as unknown as string, name: "ghost" }, // null id
      { id: "", name: "ghost-empty" }, // empty id
      { id: "tag_b", name: "focus" },
    ];

    const result = resolveTagNames({
      allTags: dirty,
      requestedNames: ["huddle", "focus", "ghost", "ghost-empty"],
      match: "any",
    });

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.resolvedIds).toEqual(["tag_a", "tag_b"]);
    expect(result.unknownNames).toEqual(["ghost", "ghost-empty"]);
    // 5 dirty rows skipped (null name, missing name, empty name, null id, empty id).
    expect(result.droppedRowCount).toBe(5);
  });

  it("reports droppedRowCount on the unsatisfiable branch too", () => {
    const dirty = [
      { id: "tag_a", name: "huddle" },
      { id: null as unknown as string, name: "ghost" },
    ];

    const result = resolveTagNames({
      allTags: dirty,
      requestedNames: ["huddle", "does-not-exist"],
      match: "all",
    });

    expect(result.kind).toBe("unsatisfiable");
    if (result.kind !== "unsatisfiable") return;
    expect(result.droppedRowCount).toBe(1);
  });

  it("reports droppedRowCount on the no_match branch too", () => {
    const dirty = [
      { id: "tag_a", name: "huddle" },
      { id: null as unknown as string, name: "ghost" },
    ];

    const result = resolveTagNames({
      allTags: dirty,
      requestedNames: ["does-not-exist"],
      match: "any",
    });

    expect(result.kind).toBe("no_match");
    if (result.kind !== "no_match") return;
    expect(result.droppedRowCount).toBe(1);
  });

  // C3 regression: case-insensitively duplicate canonical names previously
  // last-write-wins'd silently. Resolution depended on upstream order — a
  // user-facing nondeterminism — and the conflict didn't surface in
  // droppedRowCount. Fix: first-write-wins + count the dup so it bubbles
  // up as malformed_tag_rows alongside null/empty rows.
  it("treats duplicate case-insensitive names as malformed (deterministic + surfaced)", () => {
    const result = resolveTagNames({
      allTags: [
        { id: "tag_a", name: "Huddle" },
        { id: "tag_b", name: "huddle" }, // canonical-equal to tag_a
      ],
      requestedNames: ["huddle"],
      match: "any",
    });

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    // First-write-wins: tag_a resolved, tag_b dropped.
    expect(result.resolvedRows.map((r) => r.id)).toEqual(["tag_a"]);
    expect(result.droppedRowCount).toBe(1);
  });

  // Single-tag match='all' is the trivial degenerate case but resolveTagNames
  // produces a different code path than multi-tag (no fold needed). A
  // regression that early-returns `unsatisfiable` whenever match='all' with
  // requestedNames.length === 1 would silently break this case.
  it("returns ok for single-tag match='all' (degenerate case)", () => {
    const result = resolveTagNames({
      allTags,
      requestedNames: ["huddle"],
      match: "all",
    });

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.resolvedIds).toEqual(["tag_a"]);
    expect(result.unknownNames).toEqual([]);
  });

  // Empty requestedNames under match='all' must fall through to ok with
  // empty arrays — documented in the function header. A future refactor
  // that orders an "empty requestedNames" guard before the match='all'
  // branch could push this case into unsatisfiable.
  it("returns ok with empty arrays for empty requestedNames under match='all'", () => {
    const result = resolveTagNames({
      allTags,
      requestedNames: [],
      match: "all",
    });

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.resolvedIds).toEqual([]);
    expect(result.unknownNames).toEqual([]);
  });
});

describe("asTagId / asTagName", () => {
  it("brands a non-empty string as TagId", () => {
    const id = asTagId("tag_real_001");
    expect(id).toBe("tag_real_001");
  });

  it("brands a non-empty string as TagName", () => {
    const name = asTagName("huddle");
    expect(name).toBe("huddle");
  });

  it("throws on empty string for TagId", () => {
    expect(() => asTagId("")).toThrow(/Invalid TagId/);
  });

  it("throws on whitespace-only for TagId", () => {
    expect(() => asTagId("   ")).toThrow(/Invalid TagId/);
  });

  it("throws on empty string for TagName", () => {
    expect(() => asTagName("")).toThrow(/Invalid TagName/);
  });

  it("throws on whitespace-only for TagName", () => {
    expect(() => asTagName("   ")).toThrow(/Invalid TagName/);
  });
});

describe("projectValidRefs", () => {
  it("filters refs without a usable id", () => {
    const refs = [
      { id: "room_001", name: "Conf A" },
      { id: null as unknown as string, name: "Ghost" },
      { id: "" },
      { id: "room_002" }, // valid, no name
    ];

    const result = projectValidRefs(refs);

    expect(result).toEqual([{ id: "room_001", name: "Conf A" }, { id: "room_002" }]);
  });

  it("returns empty array for null/undefined input", () => {
    expect(projectValidRefs(null)).toEqual([]);
    expect(projectValidRefs(undefined)).toEqual([]);
  });

  it("drops the optional name field when upstream returns a non-string", () => {
    const refs = [{ id: "room_001", name: 42 as unknown as string }];

    const result = projectValidRefs(refs);

    expect(result).toEqual([{ id: "room_001" }]);
  });
});
