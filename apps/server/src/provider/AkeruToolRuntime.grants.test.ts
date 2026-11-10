import * as NodeFS from "node:fs";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { DEFAULT_BOT_PERMISSION_POLICY, type BotPermissionPolicy } from "@akeru/contracts";

import { createAkeruToolRuntime } from "./AkeruToolRuntime.ts";
import { makeAkeruToolRuntimeTestSupport } from "./test-support/AkeruToolRuntime.ts";

const { directories, workspace } = makeAkeruToolRuntimeTestSupport();

vi.mock("@mastra/core/workspace", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@mastra/core/workspace")>();

  return { ...actual, createWorkspaceTools: vi.fn(actual.createWorkspaceTools) };
});

const shell = {
  threadId: "thread-grants",
  toolId: "Shell" as const,
  toolCallId: "shell-1",
  input: { command: "pwd" },
  approvalMode: "require-grant" as const,
};

/** A full-access local session, where the chat mode approves routine shell commands. */
function setup() {
  let policy: BotPermissionPolicy = DEFAULT_BOT_PERMISSION_POLICY;
  const runtime = createAkeruToolRuntime();

  runtime.registerSession(shell.threadId, {
    runtimeMode: "full-access",
    workspaceType: "local",
    workspace: workspace("grants"),
    permissions: {
      principal: { kind: "owner" },
      policy,
      readPolicy: async () => policy,
    },
  });

  return {
    runtime,
    setPolicy: (next: BotPermissionPolicy) => {
      policy = next;
    },
  };
}

const ownerAsksForShell: BotPermissionPolicy = {
  ...DEFAULT_BOT_PERMISSION_POLICY,
  toolOverrides: { Shell: "ask" },
};

describe("AkeruToolRuntime approval grants", () => {
  afterEach(() => {
    for (const directory of directories) {
      NodeFS.rmSync(directory, { force: true, recursive: true });
    }

    directories.clear();
  });

  it("lets the chat mode grant a routine approval it is allowed to answer", async () => {
    const { runtime } = setup();

    runtime.openApproval(shell);
    expect(runtime.grantModeApproval(shell)).toEqual({ _tag: "Accepted" });
    await expect(runtime.execute(shell)).resolves.toBeDefined();
  });

  it("does not let an automatic grant satisfy an owner approval the policy adds later", async () => {
    const { runtime, setPolicy } = setup();

    runtime.openApproval(shell);
    expect(runtime.grantModeApproval(shell)).toEqual({ _tag: "Accepted" });
    setPolicy(ownerAsksForShell);

    await expect(runtime.execute(shell)).rejects.toThrow(
      "approval was refused (owner-approval-required)",
    );
  });

  it("refuses a mode grant when the policy already reserves the call for the owner", async () => {
    const { runtime, setPolicy } = setup();

    setPolicy(ownerAsksForShell);
    await runtime.requiresApproval(shell.threadId, shell.toolId, shell.input);
    runtime.openApproval(shell);
    expect(runtime.grantModeApproval(shell)).toEqual({
      _tag: "Rejected",
      reason: "owner-approval-required",
    });
    expect(runtime.grantApproval(shell)).toEqual({ _tag: "Accepted" });
    await expect(runtime.execute(shell)).resolves.toBeDefined();
  });

  it("never reopens a consumed approval for the identical call", async () => {
    const { runtime } = setup();

    runtime.openApproval(shell);
    expect(runtime.grantApproval(shell)).toEqual({ _tag: "Accepted" });
    await expect(runtime.execute(shell)).resolves.toBeDefined();

    runtime.openApproval(shell);
    expect(runtime.grantApproval(shell)).toEqual({
      _tag: "Rejected",
      reason: "already-answered",
    });
    expect(runtime.grantModeApproval(shell)).toEqual({
      _tag: "Rejected",
      reason: "already-answered",
    });
    await expect(runtime.execute(shell)).rejects.toThrow("requires approval");
  });

  it("refuses an answer for an approval that was never opened", async () => {
    const { runtime } = setup();

    expect(runtime.grantApproval(shell)).toEqual({ _tag: "Rejected", reason: "unknown-approval" });
    expect(runtime.grantModeApproval(shell)).toEqual({
      _tag: "Rejected",
      reason: "unknown-approval",
    });
    await expect(runtime.execute(shell)).rejects.toThrow("requires approval");
  });

  it("frees the tool call id once the thread's approvals are cleared", async () => {
    const { runtime } = setup();

    runtime.openApproval(shell);
    runtime.grantApproval(shell);
    await runtime.execute(shell);
    runtime.clearApprovals(shell.threadId);
    runtime.openApproval(shell);
    expect(runtime.grantApproval(shell)).toEqual({ _tag: "Accepted" });
  });
});
