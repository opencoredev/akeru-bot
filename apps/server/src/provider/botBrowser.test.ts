import { LocalFilesystem, LocalSandbox, Workspace } from "@mastra/core/workspace";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  createBotBrowser,
  createBotBrowserTools,
  lightpandaMcpCommand,
  type BotBrowserRpc,
} from "./botBrowser.ts";

function rpc() {
  const call = vi.fn(async (name: string) =>
    name === "tree" ? "semantic tree" : `${name} complete`,
  );
  const attachment = vi.fn(async () => ({
    browserUrl: "http://127.0.0.1:9222",
    mcpSessionId: "browser-session-1",
    requestHeaders: {},
    localRequestHeaders: {},
    availableToHostedPlugins: false,
  }));
  const close = vi.fn(async () => undefined);
  const reconnect = vi.fn(async () => undefined);
  return { call, attachment, reconnect, close } satisfies BotBrowserRpc;
}

async function executeTool(
  tool: unknown,
  input: Readonly<Record<string, unknown>>,
): Promise<unknown> {
  const execute = (tool as { execute?: (input: Readonly<Record<string, unknown>>) => unknown })
    .execute;
  if (!execute) throw new Error("expected executable tool");
  return execute(input);
}

describe("sandbox bot browser", () => {
  it("exposes only the Akeru navigate, snapshot, click, and type tools", () => {
    expect(Object.keys(createBotBrowserTools(rpc()))).toEqual([
      "browser_navigate",
      "browser_snapshot",
      "browser_click",
      "browser_type",
    ]);
  });

  it("binds the HTTP MCP browser to loopback without stdin or CDP", () => {
    expect(lightpandaMcpCommand("/tmp/lightpanda", 9223, "127.0.0.1")).toBe(
      "'/tmp/lightpanda' mcp --host '127.0.0.1' --port 9223",
    );
  });

  it("routes all four tools through one browser RPC session", async () => {
    const browserRpc = rpc();
    const tools = createBotBrowserTools(browserRpc);

    await executeTool(tools.browser_navigate, { url: "https://example.com" });
    await executeTool(tools.browser_snapshot, {});
    await executeTool(tools.browser_click, { backendNodeId: 42 });
    await executeTool(tools.browser_type, { selector: "#email", text: "leo@example.com" });

    expect(browserRpc.call.mock.calls).toEqual([
      ["goto", { url: "https://example.com" }],
      ["tree", {}],
      ["click", { backendNodeId: 42 }],
      ["fill", { selector: "#email", value: "leo@example.com" }],
    ]);
  });

  it("redacts sensitive text from semantic browser snapshots", async () => {
    const browserRpc = rpc();
    browserRpc.call.mockResolvedValueOnce(
      "Email leo@example.com token=secret-value-1234 path=/root/.ssh/id_rsa",
    );
    const result = await executeTool(createBotBrowserTools(browserRpc).browser_snapshot, {});

    expect(result).toEqual({
      snapshot: "Email [REDACTED] [REDACTED]",
      truncated: false,
    });
  });

  it("redacts sensitive text from browser action results", async () => {
    const browserRpc = rpc();
    browserRpc.call.mockResolvedValue(
      "Email leo@example.com token=secret-value-1234 path=/root/.ssh/id_rsa",
    );
    const tools = createBotBrowserTools(browserRpc);

    for (const [tool, input] of [
      [tools.browser_navigate, { url: "https://example.com" }],
      [tools.browser_click, { selector: "button" }],
      [tools.browser_type, { selector: "#email", text: "hello" }],
    ] as const) {
      await expect(executeTool(tool, input)).resolves.toEqual({
        result: "Email [REDACTED] [REDACTED]",
      });
    }
  });

  it("uses the same browser session for tools, MCP attachment, and cleanup", async () => {
    const browserRpc = rpc();
    const workspace = new Workspace({
      filesystem: new LocalFilesystem({ basePath: process.cwd() }),
      sandbox: new LocalSandbox({ workingDirectory: process.cwd() }),
    });
    const makeRpc = vi.fn(() => browserRpc);
    const browser = createBotBrowser({
      threadId: "thread-1",
      workspace,
      cacheDir: "/tmp/akeru-browser-test",
      makeRpc,
    });

    await executeTool(browser.tools.browser_click, { selector: "button" });
    await expect(browser.attachment()).resolves.toEqual({
      browserUrl: "http://127.0.0.1:9222",
      mcpSessionId: "browser-session-1",
      requestHeaders: {},
      localRequestHeaders: {},
      availableToHostedPlugins: false,
    });
    await browser.close();

    expect(makeRpc).toHaveBeenCalledOnce();
    expect(browserRpc.call).toHaveBeenCalledWith("click", { selector: "button" });
    expect(browserRpc.attachment).toHaveBeenCalledOnce();
    await browser.reconnect().catch(() => undefined);
    expect(browserRpc.reconnect).toHaveBeenCalledOnce();
    expect(browserRpc.close).toHaveBeenCalledOnce();
    await workspace.destroy();
  });
});
