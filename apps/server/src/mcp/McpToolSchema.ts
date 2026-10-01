import * as Schema from "effect/Schema";
import { decodeJson, jsonObject } from "../json.ts";
import * as Predicate from "effect/Predicate";
import * as Data from "effect/Data";
import { McpSchema } from "effect/unstable/ai";
import { type ToolInputSchema } from "./PreviewToolRegistration.ts";

export const isRecord = Predicate.isObject;

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
  const visit = (value: Schema.Json): Schema.Json => {
    if (Array.isArray(value)) return value.map(visit);

    const record = jsonObject(value);

    if (!record) return value;

    const normalized = Object.fromEntries(
      Object.entries(record)
        .filter(([key]) => key !== "allOf")
        .map(([key, child]) => [key, visit(child)]),
    );

    const allOf = Array.isArray(record.allOf) ? record.allOf.map(visit) : undefined;
    const scalar = ["string", "number", "integer", "boolean"].includes(String(record.type));
    const occupiedKeys = new Set(Object.keys(normalized));

    const canFlatten =
      scalar &&
      allOf?.every((member) => {
        const memberObject = jsonObject(member);

        if (!memberObject) return false;

        return Object.keys(memberObject).every((key) => {
          if (!providerScalarAllOfKeys.has(key)) return false;

          if (key === "description") return true;

          if (occupiedKeys.has(key)) return false;
          occupiedKeys.add(key);

          return true;
        });
      });

    if (canFlatten && allOf) {
      for (const member of allOf) {
        const memberObject = jsonObject(member);

        if (!memberObject) continue;

        for (const [key, child] of Object.entries(memberObject)) {
          if (key === "description" && "description" in normalized) continue;
          normalized[key] = child;
        }
      }

      return normalized;
    }

    return allOf ? { ...normalized, allOf } : normalized;
  };

  return jsonObject(visit(decodeJson(schema))) ?? {};
};

export const toolErrorResult = (message: string) =>
  new McpSchema.CallToolResult({
    isError: true,
    content: [{ type: "text", text: message }],
  });

export class MemoryMcpExecutionError extends Data.TaggedError("MemoryMcpExecutionError")<{
  readonly cause: unknown;
}> {}
