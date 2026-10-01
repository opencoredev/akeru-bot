import { probeTool } from "./test-support/toolProbe.ts";
import { describe } from "vite-plus/test";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { ThreadId } from "@akeru/contracts";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { AkeruSessionResources } from "./AkeruSessionResources.ts";
import { computerRegistry } from "./computerRegistry.ts";
import { WorkspaceComputer } from "./workspaceComputer.ts";
import { CODEX_COMPUTER_USE_SERVER_ID } from "./CodexComputerUse.ts";
import { makeAkeruSessionResourcesTestSupport } from "./test-support/AkeruSessionResources.ts";

const {
  directories,
  stateDir,
  workspace,
  localBotWorkspace,
  browser,
  computerServer,
  mcpManager,
  remoteInput,
} = makeAkeruSessionResourcesTestSupport();

describe("AkeruSessionResources", () => {
  afterEach(() => {
    for (const directory of directories) {
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }

    directories.clear();
  });

  it("keeps the bot workspace separate from the user computer workspace", async () => {
    const directory = stateDir();
    const project = NodePath.join(directory, "project");
    NodeFS.mkdirSync(project, { recursive: true });

    const resources = new AkeruSessionResources({
      stateDir: directory,
      makeBotBrowser: () => browser(),
      toMcpServerConfigs: () => ({}),
    });

    const acquired = await resources.acquire({
      threadId: "local-thread",
      resourceScope: "bot-one",
      workspaceResourceKey: "local:bot-one",
      workspaceId: "akeru-bot-one",
      botSandbox: "local",
      userComputerCwd: project,
      mcpServers: [],
    });

    await acquired.botWorkspace.filesystem?.writeFile("bot.txt", "bot");
    await acquired.workspace.filesystem?.writeFile("user.txt", "user");
    expect(resources.getWorkspace("local-thread")).toBe(acquired.workspace);
    expect(
      NodeFS.existsSync(NodePath.join(directory, "bot-workspaces", "akeru-bot-one", "bot.txt")),
    ).toBe(true);
    expect(NodeFS.existsSync(NodePath.join(project, "user.txt"))).toBe(true);
    expect(NodeFS.existsSync(NodePath.join(project, "bot.txt"))).toBe(false);
    await resources.shutdown();
  });

  it("allows one Computer Use controller and releases it on stop without a browser attachment", async () => {
    const manager = mcpManager({ connected: true, toolCount: 1 });
    const botBrowser = browser();

    const resources = new AkeruSessionResources({
      stateDir: stateDir(),
      hostPlatform: "darwin",
      makeRemoteWorkspace: async () => workspace(),
      makeBotBrowser: () => botBrowser,
      makeMcpManager: () => manager as never,
      resolveComputerUseServer: async () => ({
        command: "/local/launcher",
        args: ["mcp"],
        env: {},
      }),
      toMcpServerConfigs: () => ({
        [CODEX_COMPUTER_USE_SERVER_ID]: { command: "sentinel" },
      }),
    });

    const input = { ...remoteInput, mcpServers: [computerServer()] };

    await resources.acquire({ ...input, threadId: "controller" });
    await expect(resources.acquire({ ...input, threadId: "blocked" })).rejects.toThrow(
      "already controlled",
    );
    await resources.release("controller");
    await resources.acquire({ ...input, threadId: "replacement" });
    expect(botBrowser.attachment).not.toHaveBeenCalled();
    await resources.shutdown();
  });

  it("redacts Computer Use results at the MCP tool boundary", async () => {
    const execute = vi.fn(async () => ({ screenshot: { url: "https://example.com/frame.png" } }));
    const toolName = `${CODEX_COMPUTER_USE_SERVER_ID}_control`;
    const manager = mcpManager({ connected: true, toolCount: 1 }, { [toolName]: { execute } });

    const resources = new AkeruSessionResources({
      stateDir: stateDir(),
      hostPlatform: "darwin",
      makeRemoteWorkspace: async () => workspace(),
      makeBotBrowser: () => browser(),
      makeMcpManager: () => manager as never,
      resolveComputerUseServer: async () => ({
        command: "/local/launcher",
        args: ["mcp"],
        env: {},
      }),
      toMcpServerConfigs: () => ({
        [CODEX_COMPUTER_USE_SERVER_ID]: { command: "sentinel" },
      }),
    });

    await resources.acquire({
      ...remoteInput,
      threadId: "controller",
      mcpServers: [computerServer()],
    });

    const tool = probeTool(resources.getConnectorTools("controller")[toolName]);

    await expect(tool.execute({})).rejects.toThrow("unknown screenshot");
    expect(execute).toHaveBeenCalledOnce();
    await resources.shutdown();
  });

  it("releases the Computer Use lock when MCP health fails", async () => {
    const failed = mcpManager({ connected: false, toolCount: 0, error: "Accessibility denied" });
    const healthy = mcpManager({ connected: true, toolCount: 1 });

    const makeMcpManager = vi
      .fn()
      .mockReturnValueOnce(failed as never)
      .mockReturnValueOnce(healthy as never);

    const resources = new AkeruSessionResources({
      stateDir: stateDir(),
      hostPlatform: "darwin",
      makeRemoteWorkspace: async () => workspace(),
      makeBotBrowser: () => browser(),
      makeMcpManager,
      resolveComputerUseServer: async () => ({
        command: "/local/launcher",
        args: ["mcp"],
        env: {},
      }),
      toMcpServerConfigs: () => ({
        [CODEX_COMPUTER_USE_SERVER_ID]: { command: "sentinel" },
      }),
    });

    const input = { ...remoteInput, mcpServers: [computerServer()] };

    await expect(resources.acquire({ ...input, threadId: "failed" })).rejects.toThrow(
      "needs Screen Recording and Accessibility permissions",
    );
    await resources.acquire({ ...input, threadId: "replacement" });
    await resources.shutdown();
  });

  it("registers exclusive computers only when requested and unregisters on release", async () => {
    const graphical = new WorkspaceComputer(
      "daytona-id",
      {
        open: async () => undefined,
        input: async () => undefined,
        capture: async () => ({ mimeType: "image/jpeg", data: "Zg==", width: 2, height: 2 }),
      },
      async () => undefined,
      async () => ({ url: "http://127.0.0.1:9222", requestHeaders: {} }),
      async () => "running",
    );

    const resources = new AkeruSessionResources({
      stateDir: stateDir(),
      makeRemoteWorkspace: async () => ({
        ...localBotWorkspace(workspace()),
        computer: graphical,
      }),
      makeBotBrowser: () => browser(),
      toMcpServerConfigs: () => ({}),
    });

    await resources.acquire({ ...remoteInput, threadId: "legacy" });
    expect(computerRegistry.state(ThreadId.make("legacy")).capability).toBe("none");
    await resources.release("legacy");

    await resources.acquire({ ...remoteInput, threadId: "codex", exclusiveComputer: true });
    expect(computerRegistry.state(ThreadId.make("codex"))).toMatchObject({
      capability: "desktop",
      controlAvailable: true,
      workspaceId: "daytona-id",
    });
    await resources.release("codex");
    expect(computerRegistry.state(ThreadId.make("codex")).capability).toBe("none");
    await resources.shutdown();
  });
});
