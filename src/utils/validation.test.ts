import { describe, it, expect } from "vitest";
import { z } from "zod";
import { validateToolArgs } from "./validation.js";

const testSchema = z
  .object({
    name: z.string().min(1, "name is required"),
    count: z.number().int().min(1).max(100).default(10),
  })
  .strict();

describe("validateToolArgs", () => {
  it("validates correct input", () => {
    const result = validateToolArgs(testSchema, { name: "test" });
    expect(result).toEqual({ name: "test", count: 10 });
  });

  it("applies defaults", () => {
    const result = validateToolArgs(testSchema, { name: "test" });
    expect(result.count).toBe(10);
  });

  it("throws on missing required field", () => {
    expect(() => validateToolArgs(testSchema, {})).toThrow("name");
  });

  it("throws on invalid type", () => {
    expect(() => validateToolArgs(testSchema, { name: 123 })).toThrow();
  });

  it("throws on extra fields with strict schema", () => {
    expect(() => validateToolArgs(testSchema, { name: "test", extra: true })).toThrow();
  });

  it("throws on out-of-range values", () => {
    expect(() => validateToolArgs(testSchema, { name: "test", count: 200 })).toThrow();
  });

  it("formats multiple errors into single message", () => {
    expect(() => validateToolArgs(testSchema, { count: -1 })).toThrow();
  });
});
