import { describe, it, expect } from "vitest";
import { resolveTagNames } from "../tag-resolver.js";

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

    expect(result.resolvedIds).toEqual(["tag_a", "tag_b"]);
    expect(result.unknownNames).toEqual([]);
    expect(result.unsatisfiable).toBe(false);
  });

  it("collects unknown names without dropping them", () => {
    const result = resolveTagNames({
      allTags,
      requestedNames: ["huddle", "does-not-exist"],
      match: "any",
    });

    expect(result.resolvedIds).toEqual(["tag_a"]);
    expect(result.unknownNames).toEqual(["does-not-exist"]);
    expect(result.unsatisfiable).toBe(false);
  });

  it("flags unsatisfiable when match='all' and any name is unknown", () => {
    const result = resolveTagNames({
      allTags,
      requestedNames: ["huddle", "does-not-exist"],
      match: "all",
    });

    expect(result.unsatisfiable).toBe(true);
    expect(result.unknownNames).toEqual(["does-not-exist"]);
  });

  it("does not flag unsatisfiable when match='all' but every name resolves", () => {
    const result = resolveTagNames({
      allTags,
      requestedNames: ["huddle", "focus"],
      match: "all",
    });

    expect(result.unsatisfiable).toBe(false);
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

    expect(result.resolvedRows[0].organization_id).toBe("org_1");
  });

  it("returns empty arrays when no requested names are supplied", () => {
    const result = resolveTagNames({
      allTags,
      requestedNames: [],
      match: "any",
    });

    expect(result.resolvedIds).toEqual([]);
    expect(result.unknownNames).toEqual([]);
    expect(result.unsatisfiable).toBe(false);
  });

  // Per R1 §2.1: a tag row with null/missing `name` previously crashed the
  // .toLowerCase() call. Now we skip such rows defensively.
  it("skips tag rows whose name is null or missing without crashing", () => {
    const dirty = [
      { id: "tag_a", name: "huddle" },
      { id: "tag_x", name: null as unknown as string },
      { id: "tag_y" } as unknown as { id: string; name: string },
      { id: "tag_b", name: "focus" },
    ];

    const result = resolveTagNames({
      allTags: dirty,
      requestedNames: ["huddle", "focus"],
      match: "all",
    });

    expect(result.resolvedIds).toEqual(["tag_a", "tag_b"]);
    expect(result.unknownNames).toEqual([]);
    expect(result.unsatisfiable).toBe(false);
  });
});
