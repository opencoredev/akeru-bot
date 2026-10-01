import { threadId, invocation, client, TestLayer } from "./testUtils/mcpHttpServer.ts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { McpSchema, McpServer } from "effect/unstable/ai";
import * as ImageGenerationRuntime from "../image-generation/ImageGenerationRuntime.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpMemoryToolSession from "./McpMemoryToolSession.ts";

it.effect("requires both memory capability and a thread-scoped handler", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    let calls = 0;
    McpMemoryToolSession.setMcpMemoryToolSession(threadId, async ({ input }) => {
      calls += 1;

      return { success: true, message: "Memory updated.", input };
    });
    const memoryInvocation = { ...invocation, capabilities: new Set(["memory"] as const) };

    const previewOnly = yield* server
      .callTool({
        name: "memory",
        arguments: {
          target: "memory",
          operations: [{ action: "add", content: "Unauthorized note." }],
        },
      })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
        Effect.provideService(McpSchema.McpServerClient, client),
      );

    expect(previewOnly.isError).toBe(true);
    expect(calls).toBe(0);

    const result = yield* server
      .callTool({
        name: "memory",
        arguments: {
          target: "memory",
          operations: [{ action: "add", content: "Keep answers concise." }],
        },
      })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, memoryInvocation),
        Effect.provideService(McpSchema.McpServerClient, client),
      );

    expect(result.isError).toBe(false);
    expect(calls).toBe(1);
    expect(result.structuredContent).toMatchObject({
      success: true,
      message: "Memory updated.",
    });

    McpMemoryToolSession.clearMcpMemoryToolSession(threadId);

    const denied = yield* server
      .callTool({
        name: "memory",
        arguments: { target: "user", operations: [] },
      })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, memoryInvocation),
        Effect.provideService(McpSchema.McpServerClient, client),
      );

    expect(denied.isError).toBe(true);
  }).pipe(
    Effect.ensuring(Effect.sync(() => McpMemoryToolSession.clearMcpMemoryToolSession(threadId))),
    Effect.provide(TestLayer),
  ),
);

it.effect("gates generate_image on the image capability and returns metadata only", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const received: Array<unknown> = [];
      yield* ImageGenerationRuntime.activateImageGenerationRuntime({
        generate: (_threadId, input) =>
          Effect.sync(() => {
            received.push(input);

            return {
              status: "completed" as const,
              provider: "grok" as const,
              artifacts: [
                {
                  attachmentId: "thread-mcp-test-image",
                  mimeType: "image/png" as const,
                  width: 16,
                  height: 16,
                  sizeBytes: 33,
                  provider: "grok" as const,
                },
              ],
              attempts: [{ provider: "grok" as const, outcome: "completed" as const }],
            };
          }),
        cancelThread: () => Effect.void,
      });

      const call = (capabilities: ReadonlySet<McpInvocationContext.McpCapability>) =>
        server
          .callTool({
            name: "generate_image",
            arguments: { operation: "generate", prompt: "A kite", quality: "ultra" },
          })
          .pipe(
            Effect.provideService(McpInvocationContext.McpInvocationContext, {
              ...invocation,
              capabilities,
            }),
            Effect.provideService(McpSchema.McpServerClient, client),
          );

      const denied = yield* call(new Set(["preview", "memory"]));
      expect(denied.isError).toBe(true);
      expect(received).toEqual([]);

      const result = yield* call(new Set(["image"]));
      expect(result.isError).toBe(false);
      // The runtime decodes strictly, so unknown options must reach it unchanged.
      expect(received).toEqual([{ operation: "generate", prompt: "A kite", quality: "ultra" }]);
      expect(result.structuredContent).toMatchObject({
        status: "completed",
        artifacts: [{ attachmentId: "thread-mcp-test-image", mimeType: "image/png" }],
      });
      expect(result.content).toEqual([
        { type: "text", text: "Created 1 image. It is shown in the chat." },
      ]);
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("reports generate_image as unavailable when no runtime is running", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;

    const result = yield* server
      .callTool({ name: "generate_image", arguments: { operation: "generate", prompt: "A kite" } })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, {
          ...invocation,
          capabilities: new Set(["image"] as const),
        }),
        Effect.provideService(McpSchema.McpServerClient, client),
      );

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ status: "failed", kind: "unavailable" });
  }).pipe(Effect.provide(TestLayer)),
);
