// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { LocalFilesystem, LocalSandbox, Workspace } from "@mastra/core/workspace";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { createAkeruToolRuntime } from "./AkeruToolRuntime.ts";

const directories = new Set<string>();

function workspace(name: string) {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), `akeru-tool-${name}-`));
  directories.add(root);
  return new Workspace({
    filesystem: new LocalFilesystem({ basePath: root }),
    sandbox: new LocalSandbox({ workingDirectory: root }),
  });
}

describe("AkeruToolRuntime", () => {
  afterEach(() => {
    for (const directory of directories) {
      NodeFS.rmSync(directory, { force: true, recursive: true });
    }
    directories.clear();
  });

  it("only exposes tools backed by the registered computer boundaries", () => {
    const runtime = createAkeruToolRuntime();
    runtime.registerSession("thread-1", {
      runtimeMode: "approval-required",
      workspaceType: "local",
      workspace: workspace("bot"),
    });
    expect(runtime.toolsForThread("thread-1").map((tool) => tool.id)).toEqual([
      "Shell",
      "Read",
      "AwaitShell",
    ]);
  });

  it("requires an exact one-shot grant for local shell commands", async () => {
    const runtime = createAkeruToolRuntime();
    runtime.registerSession("thread-1", {
      runtimeMode: "full-access",
      workspaceType: "local",
      workspace: workspace("shell"),
    });
    const execution = {
      threadId: "thread-1",
      toolId: "Shell" as const,
      toolCallId: "tool-1",
      input: { command: "pwd" },
      approvalMode: "require-grant" as const,
    };
    await expect(runtime.execute(execution)).rejects.toThrow("requires approval");
    runtime.grantApproval({ ...execution, input: { command: "echo wrong" } });
    await expect(runtime.execute(execution)).rejects.toThrow("requires approval");
    runtime.grantApproval({ ...execution, input: { command: " pwd " } });
    await expect(runtime.execute(execution)).resolves.toBeDefined();
    await expect(runtime.execute(execution)).rejects.toThrow("requires approval");
  });

  it("copies files only when both boundaries are registered", async () => {
    const runtime = createAkeruToolRuntime();
    const bot = workspace("copy-bot");
    const user = workspace("copy-user");
    await user.filesystem?.writeFile("report.txt", "report");
    runtime.registerSession("thread-1", {
      runtimeMode: "full-access",
      workspaceType: "local",
      workspace: bot,
      userComputerWorkspace: user,
    });
    const execution = {
      threadId: "thread-1",
      toolId: "CopyToBox" as const,
      toolCallId: "tool-copy",
      input: { sourcePath: "report.txt", destinationPath: "inbox/report.txt" },
      approvalMode: "require-grant" as const,
    };
    runtime.grantApproval(execution);
    await runtime.execute(execution);
    expect(await bot.filesystem?.readFile("inbox/report.txt", { encoding: "utf-8" })).toBe(
      "report",
    );
  });

  it("translates await handles to workspace process ids", async () => {
    const runtime = createAkeruToolRuntime();
    runtime.registerSession("thread-1", {
      runtimeMode: "full-access",
      workspaceType: "cloud",
      workspace: workspace("await"),
    });
    const started = await runtime.execute({
      threadId: "thread-1",
      toolId: "Shell",
      toolCallId: "tool-start",
      input: { command: "printf done", background: true },
      approvalMode: "require-grant",
    });
    const handleId = String(started).match(/PID: ([^)]+)/)?.[1];
    if (!handleId) throw new Error("Background command did not return a process id.");
    await expect(
      runtime.execute({
        threadId: "thread-1",
        toolId: "AwaitShell",
        toolCallId: "tool-await",
        input: { handleId },
        approvalMode: "require-grant",
      }),
    ).resolves.toContain("done");
  });
});
