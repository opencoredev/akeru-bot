// @effect-diagnostics globalDate:off globalConsole:off globalRandom:off nodeBuiltinImport:off globalTimers:off globalFetch:off

import { type McpServerConfig } from "@mastra/code-sdk/mcp/index";
import { type McpServer, type OrchestrationReadModel } from "@akeru/contracts";
import { getMcpRuntimeHeaders, mcpServerNeedsBrowserAttachment } from "../../McpServerConfig.ts";
import type { BotBrowserAttachment } from "../../botBrowser.ts";

/** Active bots that lose an MCP server when it goes away: every one that has not turned it off. */
export function mcpServerDependentBots(snapshot: OrchestrationReadModel, serverId: string) {
  return snapshot.bots
    .filter(
      (bot) =>
        bot.archivedAt === null && !bot.disabledMcpServerIds.some((id) => String(id) === serverId),
    )
    .map((bot) => ({ id: bot.id, name: bot.name }));
}

export function toMcpServerConfigs(
  servers: readonly McpServer[],
  browser?: BotBrowserAttachment,
): Record<string, McpServerConfig> {
  return Object.fromEntries(
    servers.map((server) => [String(server.id), toMcpServerConfig(server, browser)]),
  );
}

/**
 * Projects one persisted Akeru MCP registration into the Mastra connection
 * recipe. Authentication headers are transient runtime state and therefore
 * never become part of the persisted contract record.
 */
export function toMcpServerConfig(
  server: McpServer,
  browser?: BotBrowserAttachment,
): McpServerConfig {
  const runtimeHeaders = getMcpRuntimeHeaders(server);
  if (server.transport === "stdio") {
    const browserAttachment =
      browser && mcpServerNeedsBrowserAttachment(server, browser.availableToHostedPlugins)
        ? {
            AKERU_BROWSER_MCP_URL: browser.browserUrl,
            AKERU_BROWSER_MCP_SESSION_ID: browser.mcpSessionId,
            AKERU_BROWSER_MCP_HEADERS: JSON.stringify(browser.localRequestHeaders),
          }
        : undefined;
    return {
      command: server.command,
      ...(server.args ? { args: [...server.args] } : {}),
      ...(browserAttachment ? { env: browserAttachment } : {}),
    };
  }

  const browserHeaders =
    browser?.availableToHostedPlugins &&
    mcpServerNeedsBrowserAttachment(server, browser.availableToHostedPlugins)
      ? {
          ...runtimeHeaders,
          "x-akeru-browser-mcp-url": browser.browserUrl,
          "x-akeru-browser-mcp-session-id": browser.mcpSessionId,
          "x-akeru-browser-mcp-headers": JSON.stringify(browser.requestHeaders),
        }
      : runtimeHeaders;
  return {
    url: server.url,
    ...(Object.keys(browserHeaders).length > 0 ? { headers: browserHeaders } : {}),
  };
}

export function mcpServerIdForToolName(
  serverIds: readonly McpServer["id"][],
  toolName: string,
): McpServer["id"] | undefined {
  return serverIds
    .toSorted((left, right) => String(right).length - String(left).length)
    .find((serverId) => toolName.startsWith(`${serverId}_`));
}
