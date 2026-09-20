# Collaborative browser

> For maintainers. Using Akeru Bot? See [docs/user](../user/).

The collaborative browser is the thread-bound preview automation that T3 Code
shipped as `preview_*` tools. Akeru did not invent it. This document records
the harness migration: Mastra sessions now call the same automation as built-in
runtime tools instead of attaching an extra product MCP server. Tool names are
unchanged, so users should not notice a behavior change.

## Native harness path

Akeru's custom harness is [`AkeruToolRuntime`][runtime] plus Mastra tools from
[`AkeruMastraTools.ts`][mastra-tools]. Codex, Claude (`claudeAgent`), Grok,
Kimi, and OpenCode Go (`opencodeGo`) use that path.

When `enableAgentBrowserAccess` is on, the runtime registers the preview tools
as siblings of `memory`. They are not members of `AkeruToolId` and do not pass
through `filterAkeruTools`. Ids, schemas, and broker operation mapping live in
[`PreviewToolHandlers.ts`][handlers]:

- `preview_status`, `preview_open`, `preview_navigate`, `preview_snapshot`
- `preview_click`, `preview_type`, `preview_press`, `preview_scroll`
- `preview_evaluate`, `preview_wait_for`, `preview_resize`
- `preview_set_appearance`
- `preview_recording_start`, `preview_recording_stop`

Each call goes to [`PreviewAutomationBroker`][broker] with a constructed
invocation scope. The broker still fans out to a connected client host; the
server does not become the browser. `providerSessionId` is
`native-preview:${threadId}` so native calls stay distinct from leftover MCP
credentials.

Mastra sessions must not inject a product `t3-code` or `akeru` MCP client just
to expose these tools. User-configured MCP servers are unrelated and still
attach through [`AkeruSessionResources`][session-resources].

## Leftover MCP path

The `/mcp` HTTP toolkit remains for leftover non-Mastra adapters:
`ClaudeAdapter`, `GrokAdapter`, `OpenCodeAdapter`, `CodexAdapter`, and Cursor.
Those adapters still attach a `t3-code` MCP server when a credential is minted.
The toolkit in [`McpHttpServer.ts`][mcp-http] and
[`mcp/toolkits/preview/`][toolkit] reaches the same broker.

[`ProviderService.prepareMcpSession`][prepare] is the leftover-adapter
credential mint. Withholding a credential there is what disables browser access
on that path. Do not reuse it as a Mastra preview bootstrap.

[runtime]: ../../apps/server/src/provider/AkeruToolRuntime.ts
[mastra-tools]: ../../apps/server/src/provider/AkeruMastraTools.ts
[handlers]: ../../apps/server/src/preview/PreviewToolHandlers.ts
[broker]: ../../apps/server/src/mcp/PreviewAutomationBroker.ts
[session-resources]: ../../apps/server/src/provider/AkeruSessionResources.ts
[mcp-http]: ../../apps/server/src/mcp/McpHttpServer.ts
[toolkit]: ../../apps/server/src/mcp/toolkits/preview/
[prepare]: ../../apps/server/src/provider/Layers/ProviderService.ts
