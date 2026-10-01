import * as Data from "effect/Data";
import { McpSchema } from "effect/unstable/ai";
import { type ToolInputSchema } from "./PreviewToolRegistration.ts";

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const providerScalarAllOfKeys = new Set([
  "description",
  "title",
  "default",
  "examples",
  "deprecated",
  "readOnly",
  "writeOnly",
  "pattern",
  "minLength",
  "maxLength",
  "format",
  "contentEncoding",
  "contentMediaType",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
]);

/**
 * Mastra converts scalar `allOf` members into Zod intersections. Constraint-only
 * members become objects, so Codex receives an object schema and sends `{}` for
 * fields such as URLs and key names. Flatten only scalar constraint members;
 * object intersections keep their original JSON Schema semantics.
 */
export const normalizeProviderToolInputSchema = (schema: ToolInputSchema): ToolInputSchema => {
  const visit = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(visit);

    if (!isRecord(value)) return value;

    const normalized = Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== "allOf")
        .map(([key, child]) => [key, visit(child)]),
    );

    const allOf = Array.isArray(value.allOf) ? value.allOf.map(visit) : undefined;
    const scalar = ["string", "number", "integer", "boolean"].includes(String(value.type));
    const occupiedKeys = new Set(Object.keys(normalized));

    const canFlatten =
      scalar &&
      allOf?.every((member) => {
        if (!isRecord(member)) return false;

        return Object.keys(member).every((key) => {
          if (!providerScalarAllOfKeys.has(key)) return false;

          if (key === "description") return true;

          if (occupiedKeys.has(key)) return false;
          occupiedKeys.add(key);

          return true;
        });
      });

    if (canFlatten && allOf) {
      for (const member of allOf) {
        if (!isRecord(member)) continue;

        for (const [key, child] of Object.entries(member)) {
          if (key === "description" && "description" in normalized) continue;
          normalized[key] = child;
        }
      }

      return normalized;
    }

    return allOf ? { ...normalized, allOf } : normalized;
  };

  return visit(schema) as ToolInputSchema;
};

export const toolErrorResult = (message: string) =>
  new McpSchema.CallToolResult({
    isError: true,
    content: [{ type: "text", text: message }],
  });

export class MemoryMcpExecutionError extends Data.TaggedError("MemoryMcpExecutionError")<{
  readonly cause: unknown;
}> {}
