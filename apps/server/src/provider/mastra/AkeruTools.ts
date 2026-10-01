import * as Predicate from "effect/Predicate";
// @effect-diagnostics globalFetch:off nodeBuiltinImport:off
import { type ToolsInput } from "@mastra/core/agent";
import { RequestContext } from "@mastra/core/request-context";
import type { StandardSchemaWithJSON } from "@mastra/core/schema";
import { createTool, type NeedsApprovalFn } from "@mastra/core/tools";
import {
  AKERU_PRODUCT_FEEDBACK_TOOL_NAME,
  AKERU_CREATE_ROUTINE_TOOL_NAME,
  AkeruCreateRoutineInput,
  ProductFeedbackToolDraft,
  type ProductFeedbackToolDraft as ProductFeedbackToolDraftValue,
} from "@akeru/contracts";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import { z } from "zod";
import { createAkeruMastraTools } from "../AkeruMastraTools.ts";
import { isCodexComputerUseTool } from "../CodexComputerUse.ts";
import { type AkeruMastraToolOptions } from "./AkeruHarnessTypes.ts";
import { controllerResourceId } from "./AkeruMemory.ts";
import { akeruActionNeedsApproval } from "./AkeruActions.ts";
import {
  routineToolInputSchema,
  AKERU_LIST_ROUTINES_TOOL_NAME,
  routineListOutputSchema,
  AKERU_DELETE_ROUTINES_TOOL_NAME,
  routineDeleteResultSchema,
} from "./AkeruRoutineSchemas.ts";

export const decodeProductFeedbackToolDraft = Schema.decodeUnknownExit(ProductFeedbackToolDraft, {
  onExcessProperty: "error",
});

export const decodeCreateRoutineInput = Schema.decodeUnknownPromise(AkeruCreateRoutineInput);

export const productFeedbackToolJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    feedback: { type: "string", minLength: 1, maxLength: 4_000 },
  },
  required: ["feedback"],
} as const;

export const productFeedbackToolInputSchema: StandardSchemaWithJSON<ProductFeedbackToolDraftValue> =
  {
    "~standard": {
      version: 1,
      vendor: "akeru-effect",
      validate: (value) => {
        const decoded = decodeProductFeedbackToolDraft(value);

        return Exit.isSuccess(decoded)
          ? { value: decoded.value }
          : { issues: [{ message: "Invalid product feedback draft." }] };
      },
      jsonSchema: {
        input: () => productFeedbackToolJsonSchema,
        output: () => productFeedbackToolJsonSchema,
      },
    },
  };

export const productFeedbackTool = createTool({
  id: AKERU_PRODUCT_FEEDBACK_TOOL_NAME,
  description:
    "Draft anonymous Akeru Bot product feedback for the user to review and send. This tool never sends feedback.",
  inputSchema: productFeedbackToolInputSchema,
  requireApproval: true,
  execute: async () => ({ status: "draft-opened" as const }),
});

export async function resolveAkeruTools(
  requestContext: RequestContext,
  options: AkeruMastraToolOptions,
): Promise<ToolsInput> {
  const threadId = controllerResourceId(requestContext);

  if (!threadId) return {};

  const routineTool = options.createRoutine
    ? createTool({
        id: AKERU_CREATE_ROUTINE_TOOL_NAME,
        description:
          "Create a disabled routine for recurring work in this chat. Call this tool as soon as the routine details are complete. The app previews the tool arguments and asks the user before execution, so do not ask for separate confirmation. Put the timing only in schedule, and make instructions describe only what each run should do. Keep the name short and specific. Use the current chat and device timezone by default. Only name plugins or skills the user explicitly requests.",
        inputSchema: routineToolInputSchema,
        requireApproval: false,
        execute: async ({ skillNames, connectorNames, ...input }) =>
          options.createRoutine!(
            threadId,
            await decodeCreateRoutineInput(
              {
                ...input,
                ...(skillNames ? { skillNames } : {}),
                ...(connectorNames ? { connectorNames } : {}),
              },
              {
                onExcessProperty: "error",
              },
            ),
          ),
      })
    : undefined;

  const listRoutinesTool = options.listRoutines
    ? createTool({
        id: AKERU_LIST_ROUTINES_TOOL_NAME,
        description:
          "List this bot's routines and show whether each schedule is enabled or disabled, plus its exact lifecycle. Use this before answering questions about routine state.",
        inputSchema: z.object({}),
        outputSchema: routineListOutputSchema,
        strict: true,
        requireApproval: false,
        execute: async () => options.listRoutines!(threadId),
      })
    : undefined;

  const deleteRoutinesTool =
    options.listRoutines && options.deleteRoutines
      ? createTool({
          id: AKERU_DELETE_ROUTINES_TOOL_NAME,
          description:
            "Delete one or more routines owned by this bot. Pass routine IDs from akeru_list_routines. This tool asks the user for confirmation before deleting anything, so do not ask for separate confirmation.",
          inputSchema: z.object({
            routineIds: z.array(z.string().trim().min(1)).min(1),
          }),
          outputSchema: routineDeleteResultSchema,
          suspendSchema: z.object({
            question: z.string(),
            options: z.array(
              z.object({
                label: z.string(),
                description: z.string(),
              }),
            ),
            selectionMode: z.literal("single_select"),
          }),
          resumeSchema: z.string(),
          strict: true,
          requireApproval: false,
          execute: async ({ routineIds }, context) => {
            const uniqueIds = [...new Set(routineIds)];
            const available = await options.listRoutines!(threadId);

            const requested = available.routines.filter((routine) =>
              uniqueIds.includes(routine.id),
            );

            if (requested.length !== uniqueIds.length) {
              return { status: "not-found" as const, deletedRoutineIds: [] };
            }

            const answer = context?.agent?.resumeData;

            if (answer === undefined) {
              const suspend = context?.agent?.suspend;

              if (!suspend) return { status: "cancelled" as const, deletedRoutineIds: [] };
              const names = requested.map((routine) => `"${routine.name}"`).join(", ");
              await suspend({
                question:
                  requested.length === 1
                    ? `Are you sure you want to delete ${names}?`
                    : `Are you sure you want to delete these routines: ${names}?`,
                options: [
                  {
                    label: "Delete routines",
                    description: "Stop these schedules and hide them from the routines list.",
                  },
                  { label: "Cancel", description: "Keep every routine." },
                ],
                selectionMode: "single_select",
              });

              return;
            }

            if (answer !== "Delete routines") {
              return { status: "cancelled" as const, deletedRoutineIds: [] };
            }

            return options.deleteRoutines!(threadId, uniqueIds);
          },
        })
      : undefined;

  return {
    ...approvalAwareTools(threadId, options.getThreadTools(threadId), options),
    ...createAkeruMastraTools(threadId, options.toolRuntime),
    [AKERU_PRODUCT_FEEDBACK_TOOL_NAME]: productFeedbackTool,
    ...(routineTool ? { [AKERU_CREATE_ROUTINE_TOOL_NAME]: routineTool } : {}),
    ...(listRoutinesTool ? { [AKERU_LIST_ROUTINES_TOOL_NAME]: listRoutinesTool } : {}),
    ...(deleteRoutinesTool ? { [AKERU_DELETE_ROUTINES_TOOL_NAME]: deleteRoutinesTool } : {}),
  };
}

export function approvalAwareTools(
  threadId: string,
  tools: ToolsInput,
  options: AkeruMastraToolOptions,
): ToolsInput {
  return Object.fromEntries(
    Object.entries(tools).map(([name, tool]) => {
      const existing =
        "needsApprovalFn" in tool
          ? (tool.needsApprovalFn ?? tool.requireApproval)
          : "requireApproval" in tool
            ? tool.requireApproval
            : undefined;

      const needsApproval: NeedsApprovalFn = async (input, context) => {
        const protectedAction =
          isCodexComputerUseTool(name) || akeruActionNeedsApproval(name, input);

        await options.syncThreadToolApproval?.(threadId, name, protectedAction);

        return (
          protectedAction ||
          (Predicate.isFunction(existing) ? await existing(input, context) : existing === true)
        );
      };

      return [name, { ...tool, requireApproval: needsApproval, needsApprovalFn: needsApproval }];
    }),
  );
}

export {
  routineTime,
  AKERU_LIST_ROUTINES_TOOL_NAME,
  AKERU_DELETE_ROUTINES_TOOL_NAME,
  routineToolInputSchema,
  routineListOutputSchema,
  type AkeruRoutineListResult,
  routineDeleteResultSchema,
  type AkeruRoutineDeleteResult,
} from "./AkeruRoutineSchemas.ts";
