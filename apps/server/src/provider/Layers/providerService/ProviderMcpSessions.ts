
/**
 * ProviderServiceLive - Cross-provider orchestration layer.
 *
 * Routes validated transport/API calls to provider adapters through
 * `ProviderAdapterRegistry` and `ProviderSessionDirectory`, and exposes a
 * unified provider event stream for subscribers.
 *
 * It does not implement provider protocol details (adapter concern).
 *
 * @module ProviderServiceLive
 */
import { ThreadId, type ProviderInstanceId } from "@akeru/contracts";

import * as Effect from "effect/Effect";

import * as McpProviderSession from "../../../mcp/McpProviderSession.ts";
import * as McpSessionRegistry from "../../../mcp/McpSessionRegistry.ts";
import type { McpCapability } from "../../../mcp/McpInvocationContext.ts";

import * as ServerSettings from "../../../serverSettings.ts";

export function createProviderMcpSessions(deps: {
  readonly serverSettings: ServerSettings.ServerSettingsService["Service"];
  readonly revokeMcpCredential: (threadId: ThreadId) => Effect.Effect<void>;
  readonly issueMcpCredential: (
    request: McpSessionRegistry.McpCredentialRequest,
  ) => Effect.Effect<McpSessionRegistry.McpIssuedCredential | undefined>;
}) {
  const mcpCapabilities = deps.serverSettings.getSettings.pipe(
    Effect.map((settings) => {
      const capabilities = new Set<McpCapability>();

      if (settings.enableAgentBrowserAccess) capabilities.add("preview");

      if (settings.imageGeneration.chatgptEnabled || settings.imageGeneration.grokEnabled) {
        capabilities.add("image");
      }

      return capabilities;
    }),
    Effect.catch((cause) =>
      Effect.logWarning(
        "Could not read server settings; withholding agent browser access and image generation for this session.",
        { cause },
      ).pipe(Effect.as(new Set<McpCapability>())),
    ),
  );

  const prepareMcpSession = (threadId: ThreadId, providerInstanceId: ProviderInstanceId) =>
    Effect.gen(function* () {
      const capabilities = yield* mcpCapabilities;

      if (capabilities.size === 0) {
        // Revoke as well as clear. Every other prepare path reaches
        // `issueActiveMcpCredential`, which revokes the thread first, so
        // skipping it here would leave a previously issued bearer token valid
        // against `/mcp` for the rest of its liveness window — and later turns
        // would keep refreshing it. A session restart (runtime mode, cwd,
        // model) re-prepares without stopping, so it relies on this.
        yield* deps.revokeMcpCredential(threadId);
        yield* Effect.sync(() => McpProviderSession.clearMcpProviderSession(threadId));

        return undefined;
      }

      const credential = yield* deps.issueMcpCredential({
        threadId,
        providerInstanceId,
        capabilities,
      });

      if (credential) {
        yield* Effect.sync(() => McpProviderSession.setMcpProviderSession(credential.config));
      }

      return credential;
    });

  const clearMcpSession = (threadId: ThreadId) =>
    McpSessionRegistry.revokeActiveMcpThread(threadId).pipe(
      Effect.tap(() => Effect.sync(() => McpProviderSession.clearMcpProviderSession(threadId))),
    );

  return { mcpCapabilities, prepareMcpSession, clearMcpSession };
}
