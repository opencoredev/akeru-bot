import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { McpSchema, McpServer, Tool } from "effect/unstable/ai";
import {
  AKERU_MEMORY_TOOL_DESCRIPTION,
  AkeruMemoryToolInputSchema,
} from "../memory/BotMemoryToolHandlers.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpMemoryToolSession from "./McpMemoryToolSession.ts";
import {
  isRecord,
  normalizeProviderToolInputSchema,
  toolErrorResult,
  MemoryMcpExecutionError,
} from "./McpToolSchema.ts";
export const decodeMemoryToolInput = Schema.decodeUnknownEffect(AkeruMemoryToolInputSchema);

export const registerMemoryTool = Effect.fn("McpHttpServer.registerMemoryTool")(function* () {
  const server = yield* McpServer.McpServer;
  const memoryTool = Tool.make("memory", {
    description: AKERU_MEMORY_TOOL_DESCRIPTION,
    parameters: AkeruMemoryToolInputSchema,
    success: Schema.Unknown,
  });
  yield* server.addTool({
    tool: new McpSchema.Tool({
      name: memoryTool.name,
      description: Tool.getDescription(memoryTool),
      inputSchema: normalizeProviderToolInputSchema(Tool.getJsonSchema(memoryTool)),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    }),
    annotations: memoryTool.annotations,
    handle: (payload) =>
      Effect.withFiber((fiber) => {
        const invocation = Context.getUnsafe(
          fiber.context,
          McpInvocationContext.McpInvocationContext,
        );
        if (!invocation.capabilities.has("memory")) {
          return Effect.succeed(toolErrorResult("This session cannot update bot memory."));
        }
        const handler = McpMemoryToolSession.readMcpMemoryToolSession(invocation.threadId);
        if (!handler) {
          return Effect.succeed(toolErrorResult("Bot memory is unavailable for this chat."));
        }
        return decodeMemoryToolInput(payload).pipe(
          Effect.flatMap((input) =>
            Effect.tryPromise({
              try: () =>
                handler({
                  threadId: String(invocation.threadId),
                  toolId: "memory",
                  toolCallId: `mcp-memory-${invocation.providerSessionId}`,
                  input,
                  approvalMode: "require-grant",
                }),
              catch: (cause) => new MemoryMcpExecutionError({ cause }),
            }),
          ),
          Effect.map(
            (result) =>
              new McpSchema.CallToolResult({
                isError: false,
                structuredContent: isRecord(result) ? result : undefined,
                content: [{ type: "text", text: JSON.stringify(result) }],
              }),
          ),
          Effect.catch((cause) =>
            Effect.succeed(
              toolErrorResult(
                cause instanceof MemoryMcpExecutionError && cause.cause instanceof Error
                  ? cause.cause.message
                  : cause instanceof Error
                    ? cause.message
                    : "Memory update failed.",
              ),
            ),
          ),
        );
      }),
  });
});
