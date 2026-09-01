import type { ToolsInput } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { AkeruToolInputSchemas } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { z } from "zod";

import {
  isMemoryToolId,
  type AkeruRuntimeToolId,
  type AkeruToolRuntime,
} from "./AkeruToolRuntime.ts";
import { AkeruMemoryToolInputSchemas } from "../memory/MemoryToolHandlers.ts";

function inputSchema(toolId: AkeruRuntimeToolId) {
  return isMemoryToolId(toolId)
    ? AkeruMemoryToolInputSchemas[toolId]
    : AkeruToolInputSchemas[toolId];
}

function omitNullValues(input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== null));
}

export function createAkeruMastraTools(threadId: string, runtime: AkeruToolRuntime): ToolsInput {
  return Object.fromEntries(
    runtime.toolsForThread(threadId).map((definition) => {
      const schema = inputSchema(definition.id);
      const standardSchema = Schema.toStandardJSONSchemaV1(schema);
      const approval = (input: unknown) =>
        runtime.requiresApproval(threadId, definition.id, omitNullValues(input));
      const tool = createTool({
        id: definition.id,
        description: definition.description,
        inputSchema: z.fromJSONSchema(
          standardSchema["~standard"].jsonSchema.input({ target: "draft-07" }),
          { defaultTarget: "draft-7" },
        ),
        requireApproval: approval,
        execute: (input, context) => {
          const toolCallId = context.agent?.toolCallId;
          if (!toolCallId) {
            throw new Error(`Tool '${definition.id}' has no call identity.`);
          }
          return runtime.execute({
            threadId,
            toolId: definition.id,
            toolCallId,
            input: omitNullValues(input),
            approvalMode: "require-grant",
          });
        },
      });
      tool.needsApprovalFn = approval;
      return [definition.id, tool] as const;
    }),
  );
}
