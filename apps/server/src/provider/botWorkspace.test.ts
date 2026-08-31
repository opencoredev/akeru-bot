// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { LocalFilesystem, LocalSandbox, Workspace } from "@mastra/core/workspace";
import { assert, describe, expect, it, vi } from "vite-plus/test";

import {
  createBotWorkspace,
  createRemoteMastraWorkspace,
  isRemoteBotSandbox,
} from "./botWorkspace.ts";

describe("createBotWorkspace", () => {
  it("classifies every managed provider", () => {
    expect(isRemoteBotSandbox("local")).toBe(false);
    for (const sandbox of ["vercel", "akeru-cloud", "upstash"] as const) {
      expect(isRemoteBotSandbox(sandbox)).toBe(true);
    }
  });

  it("keeps durable local bot files outside the user project", async () => {
    const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-workspace-"));
    const projectDir = NodePath.join(baseDir, "project");
    const botRoot = NodePath.join(baseDir, "state", "akeru-bot-one");
    NodeFS.mkdirSync(projectDir, { recursive: true });
    const workspace = await createBotWorkspace({
      threadId: "bot-one",
      cwd: projectDir,
      localRoot: botRoot,
      workspaceId: "akeru-bot-one",
      sandbox: "local",
    });
    assert.isDefined(workspace);
    expect(workspace.sandbox).toBeInstanceOf(LocalSandbox);
    expect(workspace.filesystem).toBeInstanceOf(LocalFilesystem);
    await workspace.filesystem?.writeFile("identity.txt", "bot-owned");
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
      threadId: "thread-vercel",
      sandbox: "vercel",
      workspaceId: "akeru-vercel",
      makeRemoteWorkspace,
    });
    expect(makeRemoteWorkspace).toHaveBeenCalledWith({
      threadId: "thread-vercel",
      sandbox: "vercel",
      workspaceId: "akeru-vercel",
    });
    await remote.destroy();
  });

  it.each(["vercel", "upstash", "akeru-cloud"] as const)(
    "fails closed while the %s adapter is unavailable",
    async (sandbox) => {
      await expect(
        createRemoteMastraWorkspace({ threadId: "thread-remote", sandbox }),
      ).rejects.toThrow(`Remote sandbox '${sandbox}' is unavailable`);
    },
  );
});
