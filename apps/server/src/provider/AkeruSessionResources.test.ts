import { describe } from "vite-plus/test";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { BotId } from "@akeru/contracts";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { AkeruSessionResources } from "./AkeruSessionResources.ts";
import { type AkeruRemoteSession, createRemoteBotWorkspace } from "./botWorkspace.ts";
import { makeAkeruSessionResourcesTestSupport } from "./test-support/AkeruSessionResources.ts";

const { directories, stateDir, workspace, localBotWorkspace, browser, remoteInput } =
  makeAkeruSessionResourcesTestSupport();

describe("AkeruSessionResources", () => {
  afterEach(() => {
    for (const directory of directories) {
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
    directories.clear();
  });

  it("retries failed workspace sleeps after releasing sessions during shutdown", async () => {
    const remote = workspace();
    const botWorkspace = {
      ...localBotWorkspace(remote),
      provider: "vercel" as const,
      sleep: vi
        .fn()
        .mockRejectedValueOnce(new Error("pause unavailable"))
        .mockResolvedValue(undefined),
    };
    const resources = new AkeruSessionResources({
      stateDir: stateDir(),
      makeRemoteWorkspace: async () => botWorkspace,
      makeBotBrowser: () => browser(),
      toMcpServerConfigs: () => ({}),
    });

    await resources.acquire({ ...remoteInput, threadId: "shutdown-retry" });
    await expect(resources.shutdown()).rejects.toThrow("pause unavailable");
    expect(botWorkspace.sleep).toHaveBeenCalledTimes(2);
    await resources.retryFailedWorkspaceSleeps();
  });

  it("retries a failed workspace sleep with no active session", async () => {
    const remote = workspace();
    const botWorkspace = {
      ...localBotWorkspace(remote),
      provider: "vercel" as const,
      sleep: vi
        .fn()
        .mockRejectedValueOnce(new Error("pause unavailable"))
        .mockResolvedValue(undefined),
    };
    const resources = new AkeruSessionResources({
      stateDir: stateDir(),
      makeRemoteWorkspace: async () => botWorkspace,
      makeBotBrowser: () => browser(),
      toMcpServerConfigs: () => ({}),
    });

    await resources.acquire({ ...remoteInput, threadId: "idle-retry" });
    await expect(resources.release("idle-retry")).rejects.toThrow("pause unavailable");
    await resources.retryFailedWorkspaceSleeps();
    expect(botWorkspace.sleep).toHaveBeenCalledTimes(2);
    await resources.shutdown();
  });

  it("retains attribution while another chat for the same bot is active", async () => {
    const browserFailure = vi.fn();
    let onFailure!: (error: unknown) => void;
    const resources = new AkeruSessionResources({
      stateDir: stateDir(),
      makeBotBrowser: (input) => {
        onFailure = input.onFailure!;
        return browser();
      },
      onBrowserFailure: browserFailure,
      toMcpServerConfigs: () => ({}),
    });
    const botId = BotId.make("bot-same");
    const first = { ...remoteInput, botSandbox: null, threadId: "chat-a", botId };
    const second = { ...remoteInput, botSandbox: null, threadId: "chat-b", botId };
    await resources.acquire(first);
    await resources.acquire(second);
    await resources.release(first.threadId);
    onFailure(new Error("browser exited"));
    expect(browserFailure).toHaveBeenCalledOnce();
    expect(browserFailure.mock.calls[0]?.[0].botId).toBe(botId);
    await resources.shutdown();
  });

  it("coalesces concurrent acquisition for the same thread", async () => {
    const remote = workspace();
    const stop = vi.spyOn(remote, "stop");
    let finishCreate!: () => void;
    const created = new Promise<void>((resolve) => (finishCreate = resolve));
    const makeRemoteWorkspace = vi.fn(async () => {
      await created;
      return remote;
    });
    const resources = new AkeruSessionResources({
      stateDir: stateDir(),
      makeRemoteWorkspace,
      makeBotBrowser: () => browser(),
      toMcpServerConfigs: () => ({}),
    });

    const first = resources.acquire({ ...remoteInput, threadId: "same-thread" });
    const second = resources.acquire({ ...remoteInput, threadId: "same-thread" });
    finishCreate();
    const [firstView, secondView] = await Promise.all([first, second]);
    expect(firstView).toBe(secondView);
    expect(makeRemoteWorkspace).toHaveBeenCalledOnce();
    await resources.release("same-thread");
    expect(stop).toHaveBeenCalledOnce();
    await resources.shutdown();
  });

  it("exposes the authenticated product preview tools without a plugin connection", async () => {
    const previewStatus = { execute: vi.fn(async () => ({ attached: true })) };
    const previewSnapshot = { execute: vi.fn(async () => ({ url: "https://example.com" })) };
    const manager = {
      init: vi.fn(async () => undefined),
      disconnect: vi.fn(async () => undefined),
      getTools: vi.fn(() => ({
        akeru_preview_status: previewStatus,
        akeru_preview_snapshot: previewSnapshot,
      })),
      getServerStatuses: vi.fn(() => [
        {
          name: "akeru",
          connected: true,
          toolCount: 2,
          toolNames: ["akeru_preview_status", "akeru_preview_snapshot"],
        },
      ]),
    };
    const makeMcpManager = vi.fn(
      (_projectDir: string, _configDirName?: string, _servers?: Record<string, unknown>) =>
        manager as never,
    );
    const getPreviewMcpServerConfig = vi.fn(() => ({
      url: "http://127.0.0.1:4000/mcp",
      headers: { Authorization: "Bearer preview-token" },
    }));
    const botBrowser = browser();
    const resources = new AkeruSessionResources({
      stateDir: stateDir(),
      makeRemoteWorkspace: async () => workspace(),
      makeBotBrowser: () => botBrowser,
      makeMcpManager,
      getPreviewMcpServerConfig,
      toMcpServerConfigs: () => ({}),
    });

    await resources.acquire({ ...remoteInput, threadId: "preview-thread" });

    expect(getPreviewMcpServerConfig).toHaveBeenCalledExactlyOnceWith("preview-thread");
    expect(makeMcpManager).toHaveBeenCalledOnce();
    expect(makeMcpManager.mock.calls[0]?.[2]).toEqual({
      akeru: {
        url: "http://127.0.0.1:4000/mcp",
        headers: { Authorization: "Bearer preview-token" },
      },
    });
    expect(botBrowser.attachment).not.toHaveBeenCalled();
    expect(resources.getConnectorTools("preview-thread")).toEqual({
      preview_status: previewStatus,
      preview_snapshot: previewSnapshot,
    });

    await resources.shutdown();
  });

  it("reattaches a durable remote workspace after shutdown", async () => {
    const directory = stateDir();
    const sleep = vi.fn(async () => undefined);
    const destroy = vi.fn(async () => undefined);
    const openSession = vi.fn(
      async (providerId?: string): Promise<AkeruRemoteSession> => ({
        providerId: providerId ?? "provider-1",
        inspect: async () => "running",
        run: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
        browserEndpoint: async () => ({ url: "https://browser.example", requestHeaders: {} }),
        wake: async () => undefined,
        sleep,
        destroy,
      }),
    );
    const options = {
      stateDir: directory,
      makeRemoteWorkspace: (input: Parameters<typeof createRemoteBotWorkspace>[0]) =>
        createRemoteBotWorkspace({ ...input, openSession }),
      toMcpServerConfigs: () => ({}),
    };

    const first = new AkeruSessionResources(options);
    await first.acquire({ ...remoteInput, threadId: "before-restart" });
    await first.shutdown();

    expect(sleep).toHaveBeenCalledOnce();
    expect(destroy).not.toHaveBeenCalled();
    const identityFile = NodePath.join(
      directory,
      "bot-workspaces",
      remoteInput.workspaceId,
      "provider.json",
    );
    expect(NodeFS.existsSync(identityFile)).toBe(true);

    const second = new AkeruSessionResources(options);
    await second.acquire({ ...remoteInput, threadId: "after-restart" });
    expect(openSession).toHaveBeenNthCalledWith(2, "provider-1");
    await second.release("after-restart", { destroy: true });
    expect(destroy).toHaveBeenCalledOnce();
    expect(NodeFS.existsSync(identityFile)).toBe(false);
  });
});
