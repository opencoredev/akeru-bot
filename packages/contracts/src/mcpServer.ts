import * as Schema from "effect/Schema";

import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const McpServerId = TrimmedNonEmptyString.pipe(Schema.brand("McpServerId"));
export type McpServerId = typeof McpServerId.Type;

export const McpServerTransport = Schema.Literals(["stdio", "url"]);
export type McpServerTransport = typeof McpServerTransport.Type;

export const McpServerUrl = TrimmedNonEmptyString.check(
  Schema.makeFilter((value) => {
    if (!/^https?:\/\//i.test(value)) {
      return "MCP server URL must be an absolute HTTP or HTTPS URL.";
    }
    try {
      const url = new URL(value);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        return "MCP server URL must be an absolute HTTP or HTTPS URL.";
      }
      // The registry stores no credentials; a userinfo URL would smuggle one
      // into plain event payloads.
      if (url.username !== "" || url.password !== "") {
        return "MCP server URL must not contain credentials.";
      }
      return true;
    } catch {
      return "MCP server URL must be an absolute HTTP or HTTPS URL.";
    }
  }),
);

export const MCP_SERVER_INSTRUCTIONS_MAX_CHARS = 4_000;

/**
 * Guidance a bot receives about when and how to use one MCP server. Instructions
 * are plain text, not credentials, and an empty value clears them.
 */
export const McpServerInstructions = Schema.String.check(
  Schema.isMaxLength(MCP_SERVER_INSTRUCTIONS_MAX_CHARS),
);

const StdioMcpServerConfiguration = Schema.Struct({
  name: TrimmedNonEmptyString,
  transport: Schema.Literal("stdio"),
  command: TrimmedNonEmptyString,
  args: Schema.optional(Schema.Array(Schema.String)),
});

const UrlMcpServerConfiguration = Schema.Struct({
  name: TrimmedNonEmptyString,
  transport: Schema.Literal("url"),
  url: McpServerUrl,
});

export const McpServerConfiguration = Schema.Union([
  StdioMcpServerConfiguration,
  UrlMcpServerConfiguration,
]);
export type McpServerConfiguration = typeof McpServerConfiguration.Type;

/**
 * A workspace-level raw MCP server registration. Runtime launch, Mastra tool
 * attachment, Executor, Composio, and per-bot enablement are outside this registry.
 * Credentials stay in external secret storage and never belong in this record.
 */
export const McpServer = Schema.Union([
  Schema.Struct({
    id: McpServerId,
    ...StdioMcpServerConfiguration.fields,
    instructions: Schema.optional(McpServerInstructions),
    enabled: Schema.Boolean,
    createdAt: IsoDateTime,
    updatedAt: IsoDateTime,
  }),
  Schema.Struct({
    id: McpServerId,
    ...UrlMcpServerConfiguration.fields,
    instructions: Schema.optional(McpServerInstructions),
    enabled: Schema.Boolean,
    createdAt: IsoDateTime,
    updatedAt: IsoDateTime,
  }),
]);
export type McpServer = typeof McpServer.Type;

/**
 * Resolve the global MCP registry for one bot. Global installation is the
 * default; a bot stores only the server ids it excludes.
 */
export function resolveBotMcpServers(
  servers: readonly McpServer[],
  disabledMcpServerIds: readonly McpServerId[],
): readonly McpServer[] {
  const excluded = new Set(disabledMcpServerIds);
  return servers.filter((server) => server.enabled && !excluded.has(server.id));
}
