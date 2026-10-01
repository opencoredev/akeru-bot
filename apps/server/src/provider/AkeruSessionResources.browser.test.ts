import { describe } from "vite-plus/test";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import { BotId } from "@akeru/contracts";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { AkeruSessionResources } from "./AkeruSessionResources.ts";
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

  it("shares one workspace and browser across thread sessions", async () => {
    const remote = workspace();
    const makeRemoteWorkspace = vi.fn(async () => localBotWorkspace(remote));
    const sharedBrowser = browser();
    const makeBotBrowser = vi.fn(() => sharedBrowser);

    const resources = new AkeruSessionResources({
      stateDir: stateDir(),
      makeRemoteWorkspace,
      makeBotBrowser,
      toMcpServerConfigs: () => ({}),
    });

    const first = await resources.acquire({ ...remoteInput, threadId: "first" });
    const second = await resources.acquire({ ...remoteInput, threadId: "second" });
    expect(first.workspace).toBe(second.workspace);
    expect(makeRemoteWorkspace).toHaveBeenCalledOnce();
    expect(makeBotBrowser).toHaveBeenCalledOnce();

    await resources.release("first");
    await resources.release("second");
    await resources.acquire({ ...remoteInput, threadId: "third" });
    expect(sharedBrowser.reconnect).toHaveBeenCalledOnce();
    await resources.shutdown();
    expect(sharedBrowser.close).toHaveBeenCalledOnce();
  });

  it("attributes shared browser failures and recovery to every active bot", async () => {
    const browserFailure = vi.fn();
    const browserReady = vi.fn();
    let onFailure!: (error: unknown) => void;
    let onReady!: () => void;
    const sharedBrowser = browser();

    const resources = new AkeruSessionResources({
      stateDir: stateDir(),
      makeBotBrowser: (input) => {
        onFailure = input.onFailure!;
        onReady = input.onReady!;

        return sharedBrowser;
      },
      onBrowserFailure: browserFailure,
      onBrowserReady: browserReady,
      toMcpServerConfigs: () => ({}),
    });

    const first = {
      ...remoteInput,
      botSandbox: null,
      threadId: "bot-a",
      botId: BotId.make("bot-a"),
      botName: "A",
      taskOrRoutine: "Task A",
    };

    const second = {
      ...remoteInput,
      botSandbox: null,
      threadId: "bot-b",
      botId: BotId.make("bot-b"),
      botName: "B",
      taskOrRoutine: "Task B",
    };

    await resources.acquire(first);
    await resources.acquire(second);
    onFailure(new Error("browser exited"));
    expect(browserFailure.mock.calls.map(([value]) => value.botId)).toEqual([
      first.botId,
      second.botId,
    ]);
    onReady();
    expect(browserReady.mock.calls.map(([botId]) => botId)).toEqual([first.botId, second.botId]);
    await resources.shutdown();
  });

  it("reports an active shared-browser failure to a bot that joins later", async () => {
    const browserFailure = vi.fn();
    const browserReady = vi.fn();
    let onFailure!: (error: unknown) => void;
    let onReady!: () => void;

    const resources = new AkeruSessionResources({
      stateDir: stateDir(),
      makeBotBrowser: (input) => {
        onFailure = input.onFailure!;
        onReady = input.onReady!;

        return browser();
      },
      onBrowserFailure: browserFailure,
      onBrowserReady: browserReady,
      toMcpServerConfigs: () => ({}),
    });

    const first = {
      ...remoteInput,
      botSandbox: null,
      threadId: "late-share-first",
      botId: BotId.make("late-share-first"),
    };

    const second = {
      ...remoteInput,
      botSandbox: null,
      threadId: "late-share-second",
      botId: BotId.make("late-share-second"),
    };

    await resources.acquire(first);
    onFailure(new Error("browser exited"));
    expect(browserFailure).toHaveBeenCalledOnce();
    await resources.acquire(second);
    expect(browserFailure.mock.calls.map(([input]) => input.botId)).toEqual([
      first.botId,
      second.botId,
    ]);
    onReady();
    expect(browserReady.mock.calls.map(([botId]) => botId)).toEqual([first.botId, second.botId]);
    await resources.shutdown();
  });

  it("does not pass a discarded browser failure to a replacement browser's bot", async () => {
    const browserFailure = vi.fn();
    const callbacks: Array<(error: unknown) => void> = [];

    const makeBotBrowser = vi.fn((input: { onFailure?: (error: unknown) => void }) => {
      callbacks.push(input.onFailure!);

      return browser();
    });

    const resources = new AkeruSessionResources({
      stateDir: stateDir(),
      makeBotBrowser,
      onBrowserFailure: browserFailure,
      toMcpServerConfigs: () => ({}),
    });

    const first = {
      ...remoteInput,
      botSandbox: null,
      threadId: "discarded-browser",
      botId: BotId.make("bot-a"),
    };

    const second = {
      ...first,
      threadId: "replacement-browser",
      botId: BotId.make("bot-b"),
    };

    await resources.acquire(first);
    callbacks[0]!(new Error("browser exited"));
    expect(browserFailure).toHaveBeenCalledOnce();
    await resources.release(first.threadId, { destroy: true });
    await resources.acquire(second);

    expect(makeBotBrowser).toHaveBeenCalledTimes(2);
    callbacks[0]!(new Error("old request rejected after replacement"));
    expect(browserFailure).toHaveBeenCalledOnce();
    await resources.shutdown();
  });

  it("removes a stale browser when reconnect fails", async () => {
    const firstBrowser = browser({
      reconnect: async () => Promise.reject(new Error("reconnect failed")),
    });

    const replacementBrowser = browser();

    const makeBotBrowser = vi
      .fn()
      .mockReturnValueOnce(firstBrowser)
      .mockReturnValueOnce(replacementBrowser);

    const resources = new AkeruSessionResources({
      stateDir: stateDir(),
      makeRemoteWorkspace: async () => localBotWorkspace(workspace()),
      makeBotBrowser,
      toMcpServerConfigs: () => ({}),
    });

    await resources.acquire({ ...remoteInput, threadId: "initial" });
    await resources.release("initial");
    await expect(
      resources.acquire({ ...remoteInput, threadId: "failed-reconnect" }),
    ).rejects.toThrow("reconnect failed");
    expect(firstBrowser.close).toHaveBeenCalledOnce();
    expect(resources.getConnectorTools("failed-reconnect")).toEqual({});

    await resources.acquire({ ...remoteInput, threadId: "replacement" });
    expect(makeBotBrowser).toHaveBeenCalledTimes(2);
    await resources.shutdown();
    expect(replacementBrowser.close).toHaveBeenCalledOnce();
  });

  it("replaces the browser and workspace after sleep fails", async () => {
    const failed = workspace();
    vi.spyOn(failed, "stop").mockRejectedValueOnce(new Error("sleep failed"));
    const replacement = workspace();

    const makeRemoteWorkspace = vi
      .fn()
      .mockResolvedValueOnce(localBotWorkspace(failed))
      .mockResolvedValueOnce(localBotWorkspace(replacement));

    const staleBrowser = browser();
    const replacementBrowser = browser();

    const makeBotBrowser = vi
      .fn()
      .mockReturnValueOnce(staleBrowser)
      .mockReturnValueOnce(replacementBrowser);

    const resources = new AkeruSessionResources({
      stateDir: stateDir(),
      makeRemoteWorkspace,
      makeBotBrowser,
      toMcpServerConfigs: () => ({}),
    });

    await resources.acquire({ ...remoteInput, threadId: "failed-sleep" });
    await expect(resources.release("failed-sleep")).rejects.toThrow("sleep failed");
    expect(staleBrowser.close).toHaveBeenCalledOnce();

    const acquired = await resources.acquire({ ...remoteInput, threadId: "replacement" });
    expect(acquired.workspace).toBe(replacement);
    expect(makeRemoteWorkspace).toHaveBeenCalledTimes(2);
    expect(makeBotBrowser).toHaveBeenCalledTimes(2);
    await resources.shutdown();
  });

  it("does not leave closed browser tools after a shared reconnect fails", async () => {
    const staleBrowser = browser({
      reconnect: async () => Promise.reject(new Error("shared reconnect failed")),
    });

    const replacementBrowser = browser();

    const makeBotBrowser = vi
      .fn()
      .mockReturnValueOnce(staleBrowser)
      .mockReturnValueOnce(replacementBrowser);

    const resources = new AkeruSessionResources({
      stateDir: stateDir(),
      makeRemoteWorkspace: async () => localBotWorkspace(workspace()),
      makeBotBrowser,
      toMcpServerConfigs: () => ({}),
    });

    await resources.acquire({ ...remoteInput, threadId: "initial-shared" });
    await resources.release("initial-shared");

    const reconnects = [
      resources.acquire({ ...remoteInput, threadId: "shared-one" }),
      resources.acquire({ ...remoteInput, threadId: "shared-two" }),
    ];

    await Promise.all(
      reconnects.map((acquire) => expect(acquire).rejects.toThrow("shared reconnect failed")),
    );
    expect(staleBrowser.close).toHaveBeenCalledOnce();

    await resources.acquire({ ...remoteInput, threadId: "shared-replacement" });
    expect(makeBotBrowser).toHaveBeenCalledTimes(2);
    await resources.shutdown();
  });

  it("keeps a destroy request until the final shared browser release", async () => {
    const remote = workspace();
    const destroy = vi.spyOn(remote, "destroy");
    const sharedBrowser = browser();

    const resources = new AkeruSessionResources({
      stateDir: stateDir(),
      makeRemoteWorkspace: async () => localBotWorkspace(remote),
      makeBotBrowser: () => sharedBrowser,
      toMcpServerConfigs: () => ({}),
    });

    await resources.acquire({ ...remoteInput, threadId: "first" });
    await resources.acquire({ ...remoteInput, threadId: "second" });

    await resources.release("first", { destroy: true });
    expect(sharedBrowser.close).not.toHaveBeenCalled();
    expect(destroy).not.toHaveBeenCalled();
    await resources.release("second");
    expect(sharedBrowser.close).toHaveBeenCalledOnce();
    expect(destroy).toHaveBeenCalledOnce();
    await resources.shutdown();
  });

  it("stops pooled workspaces and browsers during shutdown", async () => {
    const remote = workspace();
    const stop = vi.spyOn(remote, "stop");
    const destroy = vi.spyOn(remote, "destroy");
    const sharedBrowser = browser();

    const resources = new AkeruSessionResources({
      stateDir: stateDir(),
      makeRemoteWorkspace: async () => localBotWorkspace(remote),
      makeBotBrowser: () => sharedBrowser,
      toMcpServerConfigs: () => ({}),
    });

    await resources.acquire({ ...remoteInput, threadId: "shutdown" });
    await resources.release("shutdown");
    expect(stop).toHaveBeenCalledOnce();

    await resources.shutdown();
    expect(destroy).not.toHaveBeenCalled();
    expect(sharedBrowser.close).toHaveBeenCalledOnce();
    await expect(resources.acquire({ ...remoteInput, threadId: "late" })).rejects.toThrow(
      "shutting down",
    );
  });
});
