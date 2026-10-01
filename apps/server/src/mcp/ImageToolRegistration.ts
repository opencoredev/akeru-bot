import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { McpSchema, McpServer, Tool } from "effect/unstable/ai";
import { ImageGenerationRequest, type ImageGenerationResult } from "@akeru/contracts";
import { runImageGenerationTool } from "../image-generation/ImageGenerationRuntime.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import { normalizeProviderToolInputSchema, toolErrorResult } from "./McpToolSchema.ts";
export const IMAGE_TOOL_DESCRIPTION =
  "Generate a new image, or edit images from this chat, with the image provider the user configured. " +
  'Use operation "generate" with a prompt, or operation "edit" with a prompt and optional inputImages ' +
  "(attachment ids from this chat; defaults to the images on the latest user message). " +
  "Finished images appear in the chat automatically; do not repeat or describe the file data. " +
  'If the result status is "needs-consent", ask the user before retrying with allowProvider.';

export function imageToolText(result: ImageGenerationResult): string {
  switch (result.status) {
    case "completed": {
      const count = result.artifacts.length;
      return `Created ${count} image${count === 1 ? "" : "s"}. ${count === 1 ? "It is" : "They are"} shown in the chat.`;
    }
    case "needs-consent":
    case "failed":
      return result.message;
  }
}

export const registerImageTool = Effect.fn("McpHttpServer.registerImageTool")(function* () {
  const server = yield* McpServer.McpServer;
  const imageTool = Tool.make("generate_image", {
    description: IMAGE_TOOL_DESCRIPTION,
    parameters: ImageGenerationRequest,
    success: Schema.Unknown,
  });
  yield* server.addTool({
    tool: new McpSchema.Tool({
      name: imageTool.name,
      description: Tool.getDescription(imageTool),
      inputSchema: normalizeProviderToolInputSchema(Tool.getJsonSchema(imageTool)),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    }),
    annotations: imageTool.annotations,
    handle: (payload) =>
      Effect.withFiber((fiber) => {
        const invocation = Context.getUnsafe(
          fiber.context,
          McpInvocationContext.McpInvocationContext,
        );
        if (!invocation.capabilities.has("image")) {
          return Effect.succeed(toolErrorResult("Image generation is turned off for this chat."));
        }
        return runImageGenerationTool(invocation.threadId, payload).pipe(
          Effect.map(
            (result) =>
              new McpSchema.CallToolResult({
                isError: result.status === "failed",
                structuredContent: { ...result },
                content: [{ type: "text", text: imageToolText(result) }],
              }),
          ),
        );
      }),
  });
});
