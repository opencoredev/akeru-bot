import {
  LocalFilesystem,
  LocalSandbox,
  Workspace,
  type WorkspaceSandbox,
} from "@mastra/core/workspace";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  browserRpcErrorMessage,
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
  it("redacts sensitive browser RPC errors", () => {
    expect(
      browserRpcErrorMessage({
        code: -1,
        message: "Browser failed for leo@example.com token=secret-value-1234",
      }),
    ).toBe("Browser failed for [REDACTED] [REDACTED]");
  });

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

  it("creates and reconnects one remote browser while preserving its current URL", async () => {
    const executeCommand = vi.fn(async (command: string, args: string[] = []) => ({
      exitCode: 0,
      stdout:
        command === "uname"
          ? args[0] === "-s"
            ? "Linux\n"
            : "x86_64\n"
          : command === "sh"
            ? "4242\n"
            : "",
      stderr: "",
      success: true,
      executionTimeMs: 1,
    }));
    const workspace = new Workspace({
      filesystem: new LocalFilesystem({ basePath: process.cwd() }),
      sandbox: {
        id: "remote-workspace",
        provider: "e2b",
        executeCommand,
      } as unknown as WorkspaceSandbox,
    });
    const browserEndpoint = vi.fn(async () => ({
      url: "https://9223-e2b.example",
      requestHeaders: { "e2b-traffic-access-token": "traffic-token" },
    }));
    const messages: Array<{ method?: string; params?: { name?: string } }> = [];
    let session = 0;
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "DELETE") return new Response("", { status: 204 });
      const message = JSON.parse(String(init?.body)) as {
        method?: string;
        params?: { name?: string };
      };
      messages.push(message);
      const sessionId =
        message.method === "initialize" ? `browser-session-${++session}` : undefined;
      const text =
        message.params?.name === "session_list"
          ? JSON.stringify([{ url: "https://example.com/bottom-edge" }])
          : "ok";
      return new Response(JSON.stringify({ result: { content: [{ text }] } }), {
        status: 200,
        headers: sessionId ? { "mcp-session-id": sessionId } : {},
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const browser = createBotBrowser({
      threadId: "remote-browser",
      workspace,
      cacheDir: "/tmp/unused-remote-browser-cache",
      browserEndpoint,
    });

    try {
      await expect(browser.attachment()).resolves.toMatchObject({
        browserUrl: "https://9223-e2b.example",
        requestHeaders: { "e2b-traffic-access-token": "traffic-token" },
        localRequestHeaders: { "e2b-traffic-access-token": "traffic-token" },
        availableToHostedPlugins: true,
      });
      await executeTool(browser.tools.browser_click, { selector: "#bottom-target" });
      await browser.reconnect();
      await expect(browser.attachment()).resolves.toMatchObject({
        mcpSessionId: "browser-session-2",
      });

      expect(browserEndpoint).toHaveBeenNthCalledWith(1, 9223);
      expect(browserEndpoint).toHaveBeenNthCalledWith(2, 9223);
      expect(executeCommand.mock.calls.filter(([command]) => command === "sh")).toHaveLength(2);
      expect(messages).toContainEqual(
        expect.objectContaining({
          method: "tools/call",
          params: expect.objectContaining({ name: "goto" }),
        }),
      );
      for (const [, init] of fetchMock.mock.calls) {
        expect(init?.headers).toMatchObject({
          "e2b-traffic-access-token": "traffic-token",
        });
      }
    } finally {
      await browser.close();
      vi.unstubAllGlobals();
    }
  });

  it("fails closed when a remote workspace has no browser endpoint", async () => {
    const browser = createBotBrowser({
      threadId: "unsupported-remote-browser",
      workspace: new Workspace({
        filesystem: new LocalFilesystem({ basePath: process.cwd() }),
        sandbox: {
          id: "unsupported-remote-workspace",
          provider: "remote",
          executeCommand: vi.fn(),
        } as unknown as WorkspaceSandbox,
      }),
      cacheDir: "/tmp/unused-remote-browser-cache",
    });

    await expect(browser.attachment()).rejects.toThrow("has no Akeru browser adapter");
    await browser.close();
  });
});
