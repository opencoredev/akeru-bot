import * as NodeFS from "node:fs";
import * as DateTime from "effect/DateTime";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  BotId,
  BotPermissionPersonId,
  DEFAULT_BOT_PERMISSION_POLICY,
  type BotActionPrincipal,
  type BotPermissionPolicy,
} from "@akeru/contracts";

import { createAkeruToolRuntime } from "./AkeruToolRuntime.ts";
import { makeAkeruToolRuntimeTestSupport } from "./test-support/AkeruToolRuntime.ts";

const { directories, workspace } = makeAkeruToolRuntimeTestSupport();

vi.mock("@mastra/core/workspace", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@mastra/core/workspace")>();

  return { ...actual, createWorkspaceTools: vi.fn(actual.createWorkspaceTools) };
});

const alice = BotPermissionPersonId.make("alice");

const reaction = {
  threadId: "thread-policy",
  toolId: "ReactToMessage" as const,
  toolCallId: "reaction-1",
  input: { messageId: "message-1", emoji: "👍", action: "add" as const },
  approvalMode: "require-grant" as const,
};

function setup(options?: {
  readonly principal?: BotActionPrincipal;
  readonly policy?: BotPermissionPolicy;
}) {
  let now = DateTime.makeUnsafe("2026-10-30T12:00:00.000Z");
  let policy = options?.policy ?? DEFAULT_BOT_PERMISSION_POLICY;
  const reactToMessage = vi.fn(async () => ({ status: "applied", changed: true }));
  const runtime = createAkeruToolRuntime({ clock: () => now, approvalTtlMillis: 60_000 });

  runtime.registerSession(reaction.threadId, {
    botId: BotId.make("bot-target"),
    runtimeMode: "full-access",
    workspaceType: "none",
    reactToMessage,
    permissions: {
      principal: options?.principal ?? { kind: "owner" },
      policy,
      readPolicy: async () => policy,
    },
  });

  return {
    runtime,
    reactToMessage,
    advance: (milliseconds: number) => {
      now = DateTime.add(now, { milliseconds });
    },
    setPolicy: (next: BotPermissionPolicy) => {
      policy = next;
    },
  };
}

describe("AkeruToolRuntime permission policy", () => {
  afterEach(() => {
    for (const directory of directories) {
      NodeFS.rmSync(directory, { force: true, recursive: true });
    }

    directories.clear();
  });

  it("accepts one owner answer and refuses a replay", async () => {
    const { runtime, reactToMessage } = setup();

    expect(runtime.approvalRequirement(reaction.threadId, reaction.toolId, reaction.input)).toBe(
      "owner",
    );
    runtime.openApproval(reaction);
    expect(runtime.grantApproval(reaction)).toEqual({ _tag: "Accepted" });
    expect(runtime.grantApproval(reaction)).toEqual({
      _tag: "Rejected",
      reason: "already-answered",
    });
    await expect(runtime.execute(reaction)).resolves.toMatchObject({ status: "applied" });
    await expect(runtime.execute(reaction)).rejects.toThrow("requires approval");
    expect(reactToMessage).toHaveBeenCalledOnce();
  });

  it("refuses an answer that arrives after the approval expired", async () => {
    const { runtime, reactToMessage, advance } = setup();

    runtime.openApproval(reaction);
    advance(60_000);
    expect(runtime.grantApproval(reaction)).toEqual({ _tag: "Rejected", reason: "expired" });
    await expect(runtime.execute(reaction)).rejects.toThrow("requires approval");
    expect(reactToMessage).not.toHaveBeenCalled();
  });

  it("refuses an approved run after the approval expired", async () => {
    const { runtime, reactToMessage, advance } = setup();

    runtime.openApproval(reaction);
    expect(runtime.grantApproval(reaction)).toEqual({ _tag: "Accepted" });
    advance(60_000);
    await expect(runtime.execute(reaction)).rejects.toThrow("approval was refused (expired)");
    expect(reactToMessage).not.toHaveBeenCalled();
  });

  it("refuses an answer from anyone but the owner", async () => {
    const { runtime, reactToMessage } = setup();

    runtime.openApproval(reaction);
    expect(
      runtime.grantApproval({ ...reaction, answeredBy: { kind: "person", personId: alice } }),
    ).toEqual({ _tag: "Rejected", reason: "wrong-principal" });
    await expect(runtime.execute(reaction)).rejects.toThrow("requires approval");
    expect(reactToMessage).not.toHaveBeenCalled();
  });

  it("still accepts the owner's answer after a wrong-principal answer", async () => {
    const { runtime, reactToMessage } = setup();

    runtime.openApproval(reaction);
    expect(
      runtime.grantApproval({ ...reaction, answeredBy: { kind: "person", personId: alice } }),
    ).toEqual({ _tag: "Rejected", reason: "wrong-principal" });
    expect(runtime.grantApproval(reaction)).toEqual({ _tag: "Accepted" });
    await expect(runtime.execute(reaction)).resolves.toMatchObject({ status: "applied" });
    expect(reactToMessage).toHaveBeenCalledOnce();
  });

  it("blocks an approved run when the permission is revoked before it runs", async () => {
    const { runtime, reactToMessage, setPolicy } = setup();

    runtime.openApproval(reaction);
    expect(runtime.grantApproval(reaction)).toEqual({ _tag: "Accepted" });
    setPolicy({
      ...DEFAULT_BOT_PERMISSION_POLICY,
      toolOverrides: { ReactToMessage: "deny" },
    });

    await expect(runtime.execute(reaction)).rejects.toThrow(
      "not allowed by this bot's permission policy",
    );
    expect(reactToMessage).not.toHaveBeenCalled();
  });

  it("lets a tool override skip the prompt for an outside write", async () => {
    const { runtime, reactToMessage } = setup({
      policy: { ...DEFAULT_BOT_PERMISSION_POLICY, toolOverrides: { ReactToMessage: "allow" } },
    });

    await expect(
      runtime.requiresApproval(reaction.threadId, reaction.toolId, reaction.input),
    ).resolves.toBe(false);
    await expect(runtime.execute(reaction)).resolves.toMatchObject({ status: "applied" });
    expect(reactToMessage).toHaveBeenCalledOnce();
  });

  it("denies a request from a person the bot does not allowlist", async () => {
    const { runtime } = setup({ principal: { kind: "person", personId: alice } });

    await expect(
      runtime.requiresApproval(reaction.threadId, reaction.toolId, reaction.input),
    ).rejects.toThrow("not allowed");
    expect(runtime.approvalRequirement(reaction.threadId, reaction.toolId, reaction.input)).toBe(
      "blocked",
    );
  });

  it("caps another bot's request at what its person may do with the target bot", async () => {
    const policy: BotPermissionPolicy = {
      ...DEFAULT_BOT_PERMISSION_POLICY,
      toolOverrides: { ReactToMessage: "allow" },
      people: [
        {
          personId: alice,
          riskClasses: {
            read: "allow",
            "write-workspace": "allow",
            "write-outside": "deny",
            "environment-access": "deny",
          },
        },
      ],
    };

    const forAlice = setup({
      policy,
      principal: {
        kind: "bot",
        botId: BotId.make("bot-helper"),
        onBehalfOf: { kind: "person", personId: alice },
      },
    });

    await expect(forAlice.runtime.execute(reaction)).rejects.toThrow("not allowed");
    expect(forAlice.reactToMessage).not.toHaveBeenCalled();

    const forOwner = setup({
      policy,
      principal: { kind: "bot", botId: BotId.make("bot-helper"), onBehalfOf: { kind: "owner" } },
    });

    await expect(forOwner.runtime.execute(reaction)).resolves.toMatchObject({ status: "applied" });
  });

  it("leaves local shell approvals to the chat mode under the default policy", () => {
    const runtime = createAkeruToolRuntime();
    runtime.registerSession("thread-shell", {
      runtimeMode: "full-access",
      workspaceType: "local",
      workspace: workspace("policy-shell"),
    });

    expect(runtime.approvalRequirement("thread-shell", "Shell", { command: "pwd" })).toBe("mode");
    expect(runtime.approvalRequirement("thread-shell", "Shell", { command: "git push" })).toBe(
      "owner",
    );
    expect(runtime.approvalRequirement("thread-shell", "Read", { path: "notes.md" })).toBe("mode");
  });

  it("skips the chat mode only for a tool the bot policy explicitly allows", () => {
    const runtime = createAkeruToolRuntime();

    const cloudSession = (policy: BotPermissionPolicy) => ({
      runtimeMode: "approval-required" as const,
      workspaceType: "cloud" as const,
      workspace: workspace("policy-cloud-shell"),
      permissions: { principal: { kind: "owner" as const }, policy },
    });

    runtime.registerSession("thread-default", cloudSession(DEFAULT_BOT_PERMISSION_POLICY));
    runtime.registerSession(
      "thread-allowed",
      cloudSession({ ...DEFAULT_BOT_PERMISSION_POLICY, toolOverrides: { Shell: "allow" } }),
    );

    const install = { command: "npm install" };

    expect(runtime.approvalRequirement("thread-default", "Shell", install)).toBe("mode");
    expect(runtime.approvalRequirement("thread-allowed", "Shell", install)).toBe("none");
  });

  it("makes the owner answer a read the bot policy marks ask", async () => {
    const runtime = createAkeruToolRuntime();
    runtime.registerSession("thread-read", {
      runtimeMode: "full-access",
      workspaceType: "local",
      workspace: workspace("policy-read"),
      permissions: {
        principal: { kind: "owner" },
        policy: { ...DEFAULT_BOT_PERMISSION_POLICY, toolOverrides: { Read: "ask" } },
      },
    });

    await expect(
      runtime.requiresApproval("thread-read", "Read", { path: "notes.md" }),
    ).resolves.toBe(true);
    expect(runtime.approvalRequirement("thread-read", "Read", { path: "notes.md" })).toBe("owner");
  });
});
