import { PreviewAutomationSnapshot } from "@akeru/contracts";
import * as Predicate from "effect/Predicate";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { AiError, McpSchema, McpServer, Tool } from "effect/unstable/ai";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as PreviewAutomationBroker from "./PreviewAutomationBroker.ts";
import {
  PreviewSnapshotTool,
  PreviewSnapshotToolkit,
  PreviewStandardToolkit,
} from "./toolkits/preview/tools.ts";
import { normalizeProviderToolInputSchema, toolErrorResult } from "./McpToolSchema.ts";

export const previewSnapshotFailure = <E>(cause: Cause.Cause<E>) => {
  if (Cause.hasInterrupts(cause) || cause.reasons.some(Cause.isDieReason)) {
    return Effect.failCause(cause).pipe(Effect.orDie);
  }

  const failures = cause.reasons.filter(Cause.isFailReason);
  const firstFailure = failures[0]?.error;

  const errorTag =
    Predicate.isObjectOrArray(firstFailure) &&
    "_tag" in firstFailure &&
    Predicate.isString(firstFailure._tag)
      ? firstFailure._tag
      : "PreviewSnapshotError";

  const result = new McpSchema.CallToolResult({
    isError: true,
    structuredContent: {
      error: {
        _tag: errorTag,
        operation: "snapshot",
        failureCount: failures.length,
      },
    },
    content: [{ type: "text", text: "Preview snapshot failed." }],
  });

  return Effect.logWarning("preview snapshot failed", {
    operation: "snapshot",
    errorTag,
    failureCount: failures.length,
  }).pipe(Effect.as(result));
};

const decodeSnapshot = Schema.decodeUnknownSync(PreviewAutomationSnapshot);

export type ToolInputSchema = ReturnType<typeof Tool.getJsonSchema>;

export const registerPreviewStandardTools = Effect.fn("McpHttpServer.registerPreviewStandardTools")(
  function* () {
    const server = yield* McpServer.McpServer;
    const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
    const built = yield* PreviewStandardToolkit;

    for (const tool of Object.values(built.tools)) {
      const outputSchema = Tool.getJsonSchemaFromSchema(tool.successSchema);
      const isDeclaredFailure = Schema.is(tool.failureSchema);
      yield* server.addTool({
        tool: new McpSchema.Tool({
          name: tool.name,
          description: Tool.getDescription(tool),
          inputSchema: normalizeProviderToolInputSchema(Tool.getJsonSchema(tool)),
          ...(outputSchema.type === "object" ? { outputSchema } : {}),
          annotations: {
            ...Context.getOption(tool.annotations, Tool.Title).pipe(
              Option.map((title) => ({ title })),
              Option.getOrUndefined,
            ),
            readOnlyHint: Context.get(tool.annotations, Tool.Readonly),
            destructiveHint: Context.get(tool.annotations, Tool.Destructive),
            idempotentHint: Context.get(tool.annotations, Tool.Idempotent),
            openWorldHint: Context.get(tool.annotations, Tool.OpenWorld),
          },
        }),
        annotations: tool.annotations,
        handle: (payload) =>
          Effect.withFiber((fiber) => {
            const invocation = Context.getUnsafe(
              fiber.context,
              McpInvocationContext.McpInvocationContext,
            );

            return built.handle(tool.name, payload).pipe(
              Stream.unwrap,
              Stream.run(Sink.last()),
              Effect.flatMap(Effect.fromOption),
              Effect.provideService(PreviewAutomationBroker.PreviewAutomationBroker, broker),
              Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
              Effect.map(
                ({ encodedResult }) =>
                  new McpSchema.CallToolResult({
                    isError: false,
                    structuredContent: Predicate.isObjectKeyword(encodedResult)
                      ? encodedResult
                      : undefined,
                    content: [{ type: "text", text: JSON.stringify(encodedResult) }],
                  }),
              ),
              Effect.tapCause(Effect.logError),
              Effect.catch((error) => {
                if (AiError.isAiError(error)) {
                  const reason = error.reason;

                  return Predicate.isTagged(reason, "ToolParameterValidationError")
                    ? Effect.fail(new McpSchema.InvalidParams({ message: reason.message }))
                    : Effect.succeed(toolErrorResult("Tool execution failed."));
                }

                if (isDeclaredFailure(error)) {
                  return Effect.succeed(
                    toolErrorResult(
                      error instanceof Error ? error.message : "Tool execution failed.",
                    ),
                  );
                }

                return Effect.succeed(toolErrorResult("Tool execution failed."));
              }),
              Effect.catchDefect(() => Effect.succeed(toolErrorResult("Tool execution failed."))),
            );
          }),
      });
    }
  },
);

export const registerPreviewSnapshot = Effect.fn("McpHttpServer.registerPreviewSnapshot")(
  function* () {
    const server = yield* McpServer.McpServer;
    const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
    const built = yield* PreviewSnapshotToolkit;
    const tool = PreviewSnapshotTool;
    yield* server.addTool({
      tool: new McpSchema.Tool({
        name: tool.name,
        description: Tool.getDescription(tool),
        inputSchema: Tool.getJsonSchema(tool),
        annotations: {
          ...Context.getOption(tool.annotations, Tool.Title).pipe(
            Option.map((title) => ({ title })),
            Option.getOrUndefined,
          ),
          readOnlyHint: Context.get(tool.annotations, Tool.Readonly),
          destructiveHint: Context.get(tool.annotations, Tool.Destructive),
          idempotentHint: Context.get(tool.annotations, Tool.Idempotent),
          openWorldHint: Context.get(tool.annotations, Tool.OpenWorld),
        },
      }),
      annotations: tool.annotations,
      handle: (payload) =>
        Effect.withFiber((fiber) => {
          const invocation = Context.getUnsafe(
            fiber.context,
            McpInvocationContext.McpInvocationContext,
          );

          return built.handle("preview_snapshot", payload).pipe(
            Stream.unwrap,
            Stream.run(Sink.last()),
            Effect.flatMap(Effect.fromOption),
            Effect.provideService(PreviewAutomationBroker.PreviewAutomationBroker, broker),
            Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
            Effect.matchCauseEffect({
              onFailure: previewSnapshotFailure,
              onSuccess: ({ encodedResult }) => {
                const snapshot = decodeSnapshot(encodedResult);

                const { screenshot, ...page } = snapshot;

                const metadata = {
                  ...page,
                  screenshot: {
                    mimeType: screenshot.mimeType,
                    width: screenshot.width,
                    height: screenshot.height,
                    redacted: true,
                  },
                };

                return Effect.succeed(
                  new McpSchema.CallToolResult({
                    isError: false,
                    structuredContent: metadata,
                    content: [
                      { type: "text", text: JSON.stringify(metadata) },
                      ...(payload?.includeImage === false
                        ? []
                        : [
                            {
                              type: "image" as const,
                              data: new Uint8Array(Buffer.from(screenshot.data, "base64")),
                              mimeType: screenshot.mimeType,
                            },
                          ]),
                    ],
                  }),
                );
              },
            }),
          );
        }),
    });
  },
);
