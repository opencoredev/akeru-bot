// @effect-diagnostics globalDate:off globalConsole:off globalRandom:off nodeBuiltinImport:off globalTimers:off globalFetch:off

import type { AgentControllerLiveOptions } from "./Options.ts";

// @effect-diagnostics globalDate:off globalConsole:off globalRandom:off nodeBuiltinImport:off globalTimers:off globalFetch:off

import { ThreadId } from "@akeru/contracts";

import { BotInboxService } from "../../../bot-inbox/service.ts";
import {
  recordBrowserFailure,
  resolveBrowserFailure,
} from "../../../bot-inbox/browserIncidents.ts";
import { ServerConfig } from "../../../config.ts";

import * as McpProviderSession from "../../../mcp/McpProviderSession.ts";

import { SubscriptionAuthService } from "../../../subscription-auth/service.ts";

import { AkeruSessionResources } from "../../AkeruSessionResources.ts";

import { toMcpServerConfigs } from "./McpConfiguration.ts";

export function createSessionResources(deps: {
  readonly config: ServerConfig["Service"];
  readonly hostPlatform: NodeJS.Platform;
  readonly subscriptionAuth: SubscriptionAuthService;
  readonly botInbox: BotInboxService;
  readonly options: AgentControllerLiveOptions | undefined;
}) {
  const sessionResources = new AkeruSessionResources({
    stateDir: deps.config.stateDir,
    hostPlatform: deps.hostPlatform,
    getPreviewMcpServerConfig: (threadId) => {
      const session = McpProviderSession.readMcpProviderSession(ThreadId.make(threadId));
      return session
        ? {
            url: session.endpoint,
            headers: { Authorization: session.authorizationHeader },
          }
        : undefined;
    },
    toMcpServerConfigs,
    onMcpServerConnectionFailure: (serverId) =>
      deps.subscriptionAuth.recordMcpRequestFailure(serverId, "The MCP server failed to connect."),
    onBrowserFailure: (input) => recordBrowserFailure(deps.botInbox, input),
    onBrowserReady: (botId, resourceKey) =>
      resolveBrowserFailure(deps.botInbox, botId, resourceKey),
    ...(deps.options?.makeMcpManager ? { makeMcpManager: deps.options.makeMcpManager } : {}),
    ...(deps.options?.makeRemoteWorkspace
      ? { makeRemoteWorkspace: deps.options.makeRemoteWorkspace }
      : {}),
    ...(deps.options?.makeBotBrowser ? { makeBotBrowser: deps.options.makeBotBrowser } : {}),
    ...(deps.options?.resolveComputerUseServer
      ? { resolveComputerUseServer: deps.options.resolveComputerUseServer }
      : {}),
  });
  return { sessionResources };
}
