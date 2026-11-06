import { workspaceIO } from "./test-support/workspaceIO.ts";
import { describe } from "vite-plus/test";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { LocalFilesystem, LocalSandbox, Workspace } from "@mastra/core/workspace";
import { assert, expect, it, vi } from "vite-plus/test";
import {
  createBotWorkspace,
  createRemoteBotWorkspace,
  isRemoteBotSandbox,
} from "./botWorkspace.ts";
import { makebotWorkspaceTestSupport } from "./test-support/botWorkspace.ts";

const { remoteSession } = makebotWorkspaceTestSupport();

const remoteSessionWorkspace = () =>
  new Workspace({
    filesystem: new LocalFilesystem({ basePath: process.cwd() }),
    sandbox: new LocalSandbox({ workingDirectory: process.cwd() }),
  });

describe("createBotWorkspace", () => {
  it("classifies every managed provider", () => {
    expect(isRemoteBotSandbox("local")).toBe(false);

    for (const sandbox of [
      "e2b",
      "daytona",
      "vercel",
      "upstash",
      "ascii",
      "railway",
      "tenki",
      "boat",
      "docker",
    ] as const) {
      expect(isRemoteBotSandbox(sandbox)).toBe(true);
    }
  });

  it("keeps durable local bot files outside the user project", async () => {
    const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-workspace-"));
    const projectDir = NodePath.join(baseDir, "project");
    const botRoot = NodePath.join(baseDir, "state", "akeru-bot-one");
    NodeFS.mkdirSync(projectDir, { recursive: true });

    const workspace = await createBotWorkspace({
      io: workspaceIO,
      threadId: "bot-one",
      cwd: projectDir,
      localRoot: botRoot,
      workspaceId: "akeru-bot-one",
      sandbox: "local",
    });

    assert.isDefined(workspace);
    expect(workspace.workspace.sandbox).toBeInstanceOf(LocalSandbox);
    expect(workspace.workspace.filesystem).toBeInstanceOf(LocalFilesystem);
    await workspace.workspace.filesystem?.writeFile("identity.txt", "bot-owned");
    expect(NodeFS.readFileSync(NodePath.join(botRoot, "identity.txt"), "utf8")).toBe("bot-owned");
    expect(NodeFS.existsSync(NodePath.join(projectDir, "identity.txt"))).toBe(false);
    await workspace.destroy();
    NodeFS.rmSync(baseDir, { recursive: true, force: true });
  });

  it("passes stable identity to an injected remote provider", async () => {
    const remote = new Workspace({
      filesystem: new LocalFilesystem({ basePath: process.cwd() }),
      sandbox: new LocalSandbox({ workingDirectory: process.cwd() }),
    });

    const makeRemoteWorkspace = vi.fn(async () => remote);
    await createBotWorkspace({
      io: workspaceIO,
      threadId: "thread-vercel",
      sandbox: "vercel",
      workspaceId: "akeru-vercel",
      environment: {
        VERCEL_TOKEN: "token",
        VERCEL_TEAM_ID: "team",
        VERCEL_PROJECT_ID: "project",
      },
      makeRemoteWorkspace,
    });
    expect(makeRemoteWorkspace).toHaveBeenCalledWith({
      io: workspaceIO,
      threadId: "thread-vercel",
      sandbox: "vercel",
      workspaceId: "akeru-vercel",
      environment: {
        VERCEL_TOKEN: "token",
        VERCEL_TEAM_ID: "team",
        VERCEL_PROJECT_ID: "project",
      },
    });
    await remote.destroy();
  });

  it("requires stable identity for remote workspaces", async () => {
    await expect(
      createRemoteBotWorkspace({ io: workspaceIO, threadId: "thread-remote", sandbox: "e2b" }),
    ).rejects.toThrow("needs a stable workspace identity");
  });

  it("persists the provider identity and uses it to reattach", async () => {
    const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-identity-"));
    const identityFile = NodePath.join(baseDir, "provider.json");

    const openSession = vi.fn(async (providerId?: string) =>
      remoteSession(providerId ?? "native-workspace-id"),
    );

    const input = {
      io: workspaceIO,
      threadId: "thread-remote",
      sandbox: "e2b" as const,
      workspaceId: "akeru-stable-id",
      identityFile,
      openSession,
    };

    const created = await createRemoteBotWorkspace(input);
    const reattached = await createRemoteBotWorkspace(input);

    expect(created.id).toBe("akeru-stable-id");
    expect(reattached.id).toBe("akeru-stable-id");
    expect(reattached.providerId).toBe("native-workspace-id");
    expect(openSession).toHaveBeenNthCalledWith(1, undefined);
    expect(openSession).toHaveBeenNthCalledWith(2, "native-workspace-id");
    expect(JSON.parse(NodeFS.readFileSync(identityFile, "utf8"))).toEqual({
      provider: "e2b",
      providerId: "native-workspace-id",
    });
    await reattached.destroy();
    expect(NodeFS.existsSync(identityFile)).toBe(false);
    NodeFS.rmSync(baseDir, { recursive: true, force: true });
  });

  it.each([
    ["no sandbox is saved", undefined],
    ["the saved sandbox is a different one", { provider: "railway", providerId: "vm-other" }],
    [
      "the saved sandbox is left by a failed setup",
      { provider: "railway", providerId: "vm-1", cleanup: true },
    ],
  ] as const)("cleanup's reattach creates nothing when %s", async (_, identity) => {
    const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-reattach-"));
    const identityFile = NodePath.join(baseDir, "provider.json");

    if (identity) NodeFS.writeFileSync(identityFile, `${JSON.stringify(identity)}\n`);
    const makeRemoteWorkspace = vi.fn(async () => remoteSessionWorkspace());

    await expect(
      createBotWorkspace({
        io: workspaceIO,
        threadId: "bot-one",
        sandbox: "railway",
        workspaceId: "akeru-stable-id",
        identityFile,
        reattach: { providerId: "vm-1" },
        makeRemoteWorkspace,
      }),
    ).resolves.toBeUndefined();
    expect(makeRemoteWorkspace).not.toHaveBeenCalled();
    NodeFS.rmSync(baseDir, { recursive: true, force: true });
  });

  it("cleanup's reattach reaches the saved sandbox it lost", async () => {
    const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-reattach-"));
    const identityFile = NodePath.join(baseDir, "provider.json");
    NodeFS.writeFileSync(
      identityFile,
      `${JSON.stringify({ provider: "e2b", providerId: "vm-1" })}\n`,
    );
    const openSession = vi.fn(async (providerId?: string) => remoteSession(providerId ?? "new"));

    const reattached = await createBotWorkspace({
      io: workspaceIO,
      threadId: "bot-one",
      sandbox: "e2b",
      workspaceId: "akeru-stable-id",
      identityFile,
      reattach: { providerId: "vm-1" },
      makeRemoteWorkspace: (input) => createRemoteBotWorkspace({ ...input, openSession }),
    });

    expect(reattached).toMatchObject({ providerId: "vm-1", created: false });
    expect(openSession).toHaveBeenCalledExactlyOnceWith("vm-1");
    NodeFS.rmSync(baseDir, { recursive: true, force: true });
  });

  it("a remote reattach fails rather than creating when its saved sandbox is gone", async () => {
    const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-reattach-"));
    const openSession = vi.fn(async () => remoteSession("vm-2"));

    await expect(
      createRemoteBotWorkspace({
        io: workspaceIO,
        threadId: "bot-one",
        sandbox: "e2b",
        workspaceId: "akeru-stable-id",
        identityFile: NodePath.join(baseDir, "provider.json"),
        reattach: {},
        openSession,
      }),
    ).rejects.toThrow("cleanup never creates one");
    expect(openSession).not.toHaveBeenCalled();
    NodeFS.rmSync(baseDir, { recursive: true, force: true });
  });

  it("fails closed when a persisted remote workspace is missing", async () => {
    const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-missing-"));
    const identityFile = NodePath.join(baseDir, "provider.json");
    NodeFS.writeFileSync(
      identityFile,
      `${JSON.stringify({ provider: "vercel", providerId: "missing-id" })}\n`,
    );

    await expect(
      createRemoteBotWorkspace({
        io: workspaceIO,
        threadId: "thread-remote",
        sandbox: "vercel",
        workspaceId: "akeru-stable-id",
        identityFile,
        openSession: async () => Promise.reject(new Error("not found")),
      }),
    ).rejects.toThrow(`Remove '${identityFile}' to create a replacement`);
    expect(NodeFS.existsSync(identityFile)).toBe(true);
    NodeFS.rmSync(baseDir, { recursive: true, force: true });
  });
});
