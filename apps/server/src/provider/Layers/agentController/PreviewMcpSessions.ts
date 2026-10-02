import type { AgentControllerLiveOptions } from "./Options.ts";

import { ProviderInstanceId, ThreadId } from "@akeru/contracts";

import * as Effect from "effect/Effect";

import * as Option from "effect/Option";

import { type AkeruMemoryToolHandler } from "../../../memory/BotMemoryToolHandlers.ts";

import * as McpProviderSession from "../../../mcp/McpProviderSession.ts";
import * as McpMemoryToolSession from "../../../mcp/McpMemoryToolSession.ts";
import * as McpInvocationContext from "../../../mcp/McpInvocationContext.ts";
import * as McpSessionRegistry from "../../../mcp/McpSessionRegistry.ts";
import * as ServerSettings from "../../../serverSettings.ts";

export function createPreviewMcpSessions(deps: {
  readonly options: AgentControllerLiveOptions | undefined;
  readonly mcpSessionRegistry: Option.Option<McpSessionRegistry.McpSessionRegistryShape>;
  readonly serverSettings: Option.Option<ServerSettings.ServerSettingsService["Service"]>;
}) {
  const mcpSessionRegistry = deps.mcpSessionRegistry;

  const issueMcpCredential =
    deps.options?.issueMcpCredential ??
    (Option.isSome(mcpSessionRegistry)
      ? (request: McpSessionRegistry.McpCredentialRequest) =>
          mcpSessionRegistry.value.revokeThread(request.threadId).pipe(
            Effect.andThen(mcpSessionRegistry.value.issue(request)),
            Effect.map((credential) => ({ config: credential.config })),
          )
      : McpSessionRegistry.issueActiveMcpCredential);

  const revokeMcpCredential =
    deps.options?.revokeMcpCredential ??
    (Option.isSome(mcpSessionRegistry)
      ? mcpSessionRegistry.value.revokeThread
      : McpSessionRegistry.revokeActiveMcpThread);

  const clearPreviewMcpSession = (threadId: ThreadId) =>
    revokeMcpCredential(threadId).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          McpProviderSession.clearMcpProviderSession(threadId);
          McpMemoryToolSession.clearMcpMemoryToolSession(threadId);
        }),
      ),
    );

  const preparePreviewMcpSession = (
    threadId: ThreadId,
    providerInstanceId: ProviderInstanceId,
    memoryHandler?: AkeruMemoryToolHandler,
  ) =>
    Effect.gen(function* () {
      // Matches ProviderService's capabilities: an unreadable settings file withholds both.
      const { previewEnabled, imageEnabled } = Option.isSome(deps.serverSettings)
        ? yield* deps.serverSettings.value.getSettings.pipe(
            Effect.map((settings) => ({
              previewEnabled: settings.enableAgentBrowserAccess,
              imageEnabled:
                settings.imageGeneration.chatgptEnabled || settings.imageGeneration.grokEnabled,
            })),
            Effect.orElseSucceed(() => ({ previewEnabled: false, imageEnabled: false })),
          )
        : { previewEnabled: true, imageEnabled: false };

      const capabilities = new Set<McpInvocationContext.McpCapability>([
        ...(previewEnabled ? (["preview"] as const) : []),
        ...(imageEnabled ? (["image"] as const) : []),
        ...(memoryHandler ? (["memory"] as const) : []),
      ]);

      if (capabilities.size === 0) {
        yield* clearPreviewMcpSession(threadId);

        return;
      }

      const credential = yield* issueMcpCredential({
        threadId,
        providerInstanceId,
        capabilities,
      });

      if (credential) {
        yield* Effect.sync(() => {
          McpProviderSession.setMcpProviderSession(credential.config);

          if (memoryHandler) {
            McpMemoryToolSession.setMcpMemoryToolSession(threadId, memoryHandler);
          } else {
            McpMemoryToolSession.clearMcpMemoryToolSession(threadId);
          }
        });
      }
    });

  return {
    issueMcpCredential,
    revokeMcpCredential,
    clearPreviewMcpSession,
    preparePreviewMcpSession,
  };
}
