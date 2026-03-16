import { z } from "zod";
import { createValidationError } from "../errors/mcp-errors.js";

/**
 * Validate tool arguments using a Zod schema
 * @throws Error with user-friendly validation messages
 */
export function validateToolArgs<T>(schema: z.ZodSchema<T>, args: unknown): T {
  try {
    return schema.parse(args);
  } catch (error) {
    if (error instanceof z.ZodError) {
      // Format Zod errors into user-friendly messages
      const messages = error.errors.map((err) => {
        const path = err.path.join(".");
        return `${path ? `${path}: ` : ""}${err.message}`;
      });
      throw createValidationError(messages.join("; "));
    }
    throw error;
  }
}
