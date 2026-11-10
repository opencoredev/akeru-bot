import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type {
  HookCallback,
  HookJSONOutput,
  Options as ClaudeQueryOptions,
} from "@anthropic-ai/claude-agent-sdk";
import {
  ApprovalRequestId,
  BotId,
  ThreadId,
  type BotPermissionPolicy,
  type ProviderInstanceEnvironment,
} from "@akeru/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import { FakeClaudeQuery } from "../Layers/test-support/claudeAdapterHarness.ts";
import {
  HOSTILE_SERVER_ENVIRONMENT,
  claudeCodeTestLayer,
  makeClaudeCodeAdapter,
  nextEvent,
  policyWith,
} from "../Layers/test-support/claudeCodeAdapterHarness.ts";
import {
  clearBotToolPermissionSession,
  setBotToolPermissionSession,
} from "../tools/BotToolPermissionSessions.ts";
import { CLAUDE_CODE_DRIVER_KIND } from "./ClaudeCodeLogin.ts";

const BOT_ID = BotId.make("bot-ada");

/** A workspace inside a throwaway home, which is also the session's HOME. */
function makeHome() {
  const home = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-claude-policy-")),
  );

  const workspace = NodePath.join(home, "project");
  NodeFS.mkdirSync(workspace);

  return { home, workspace };
}

const startPolicySession = (
  policy: () => BotPermissionPolicy,
  instance?: ProviderInstanceEnvironment,
  { registerPolicy = true }: { readonly registerPolicy?: boolean } = {},
) =>
  Effect.gen(function* () {
    const { home, workspace } = makeHome();
    const fake = new FakeClaudeQuery();
    let options: ClaudeQueryOptions | undefined;

    const adapter = yield* makeClaudeCodeAdapter(
      (input) => {
        options = input.options;

        return fake;
      },
      { base: { ...HOSTILE_SERVER_ENVIRONMENT, HOME: home }, ...(instance ? { instance } : {}) },
    );

    const threadId = ThreadId.make(`thread-claude-code-policy-${NodePath.basename(home)}`);

    if (registerPolicy) {
      setBotToolPermissionSession(threadId, {
        botId: BOT_ID,
        permissions: {
          principal: { kind: "owner" },
          policy: policy(),
          readPolicy: async () => policy(),
        },
      });
    }

    yield* adapter.startSession({
      threadId,
      provider: CLAUDE_CODE_DRIVER_KIND,
      runtimeMode: "full-access",
      botId: BOT_ID,
      cwd: workspace,
    });

    const canUseTool = options?.canUseTool;
    const hook = options?.hooks?.PreToolUse?.[0]?.hooks[0];

    if (!canUseTool || !hook) throw new Error("The session has no permission callbacks.");

    const preToolUse = (toolName: string, toolInput: Record<string, string>, id: string) =>
      Effect.promise(() =>
        (hook satisfies HookCallback)(
          {
            hook_event_name: "PreToolUse",
            session_id: "session",
            transcript_path: NodePath.join(home, "transcript"),
            cwd: workspace,
            tool_name: toolName,
            tool_input: toolInput,
            tool_use_id: id,
          },
          id,
          { signal: new AbortController().signal },
        ),
      );

    const cleanup = Effect.gen(function* () {
      clearBotToolPermissionSession(threadId);
      yield* adapter.stopSession(threadId);
    });

    return { adapter, threadId, home, workspace, canUseTool, preToolUse, cleanup };
  });

const decisionOf = (output: HookJSONOutput) => JSON.stringify(output);

describe("Claude Code login policy on file paths", () => {
  it.effect("treats a read outside the workspace as access to the user's computer", () =>
    Effect.gen(function* () {
      const session = yield* startPolicySession(() => policyWith({ "environment-access": "deny" }));

      const signal = new AbortController().signal;
      const privateFile = NodePath.join(session.home, "Documents", "private.txt");

      const outside = yield* Effect.promise(() =>
        session.canUseTool("Read", { file_path: privateFile }, { signal, toolUseID: "read-1" }),
      );

      assert.equal(outside.behavior, "deny");

      const hooked = yield* session.preToolUse("Read", { file_path: privateFile }, "read-2");
      assert.include(decisionOf(hooked), '"permissionDecision":"deny"');

      const inside = yield* Effect.promise(() =>
        session.canUseTool("Read", { file_path: "src/a.ts" }, { signal, toolUseID: "read-3" }),
      );

      assert.equal(inside.behavior, "allow");

      yield* session.cleanup;
    }).pipe(Effect.provide(claudeCodeTestLayer)),
  );

  it.effect("refuses Claude Code's login and settings even in Full access", () =>
    Effect.gen(function* () {
      const session = yield* startPolicySession(() => policyWith({}));
      const signal = new AbortController().signal;

      for (const [toolName, input] of [
        ["Read", { file_path: "~/.claude/.credentials.json" }],
        ["Read", { file_path: NodePath.join(session.home, ".claude.json") }],
        ["mcp__filesystem__read_file", { path: "~/.claude/.credentials.json" }],
      ] as const) {
        const result = yield* Effect.promise(() =>
          session.canUseTool(toolName, input, { signal, toolUseID: `config-${toolName}` }),
        );

        assert.equal(result.behavior, "deny", toolName);
        assert.include(result.behavior === "deny" ? result.message : "", "login or settings");
      }

      yield* session.cleanup;
    }).pipe(Effect.provide(claudeCodeTestLayer)),
  );

  it.effect("asks the owner before a write outside the workspace, with the path on the card", () =>
    Effect.gen(function* () {
      const session = yield* startPolicySession(() => policyWith({}));
      const bashrc = NodePath.join(session.home, ".bashrc");

      const pending = session.preToolUse("Write", { file_path: bashrc, content: "x" }, "write-1");
      const fiber = yield* Effect.forkChild(pending);
      const opened = yield* nextEvent(session.adapter.streamEvents, "request.opened");

      if (opened.type !== "request.opened" || opened.requestId === undefined) {
        throw new Error("No approval opened.");
      }

      assert.equal(opened.payload.toolName, "Write");
      assert.deepInclude(opened.payload.args, { file_path: bashrc });
      assert.include(opened.payload.detail ?? "", bashrc);
      assert.include(opened.payload.detail ?? "", "outside the bot's workspace");

      yield* session.adapter.respondToRequest(
        session.threadId,
        ApprovalRequestId.make(opened.requestId),
        "decline",
      );

      assert.include(decisionOf(yield* Fiber.join(fiber)), '"permissionDecision":"deny"');

      yield* session.cleanup;
    }).pipe(Effect.provide(claudeCodeTestLayer)),
  );
});

describe("Claude Code login owner approvals", () => {
  it.effect("show the exact command and why the policy asks", () =>
    Effect.gen(function* () {
      const session = yield* startPolicySession(() => policyWith({}));
      const command = "git push --force origin main && rm -rf build/";

      const fiber = yield* Effect.forkChild(
        session.preToolUse("Bash", { command, description: "Ship it" }, "bash-1"),
      );

      const opened = yield* nextEvent(session.adapter.streamEvents, "request.opened");

      if (opened.type !== "request.opened" || opened.requestId === undefined) {
        throw new Error("No approval opened.");
      }

      assert.equal(opened.payload.toolName, "Bash");
      assert.deepInclude(opened.payload.args, { command });
      assert.match(
        opened.payload.detail ?? "",
        new RegExp(`^${command.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}\\n\\n`),
      );
      assert.include(opened.payload.detail ?? "", "permission policy asks you first");
      assert.deepEqual(
        opened.payload.options?.map((option) => option.decision),
        ["decline", "accept"],
      );

      yield* session.adapter.respondToRequest(
        session.threadId,
        ApprovalRequestId.make(opened.requestId),
        "accept",
      );

      assert.include(decisionOf(yield* Fiber.join(fiber)), '"permissionDecision":"allow"');

      yield* session.cleanup;
    }).pipe(Effect.provide(claudeCodeTestLayer)),
  );
});

describe("Claude Code login shell commands near Claude Code's files", () => {
  it.effect("always ask the owner, even when the policy allows everything", () =>
    Effect.gen(function* () {
      const session = yield* startPolicySession(() =>
        policyWith({ "write-outside": "allow", "environment-access": "allow" }),
      );

      const command = 'cat "$HOME"/.claude/.credentials.json';

      const fiber = yield* Effect.forkChild(session.preToolUse("Bash", { command }, "shell-1"));
      const opened = yield* nextEvent(session.adapter.streamEvents, "request.opened");

      if (opened.type !== "request.opened" || opened.requestId === undefined) {
        throw new Error("No approval opened.");
      }

      assert.deepInclude(opened.payload.args, { command });
      assert.include(opened.payload.detail ?? "", command);
      assert.include(opened.payload.detail ?? "", "Claude Code's own login or settings");
      assert.deepEqual(
        opened.payload.options?.map((option) => option.decision),
        ["decline", "accept"],
      );

      yield* session.adapter.respondToRequest(
        session.threadId,
        ApprovalRequestId.make(opened.requestId),
        "decline",
      );

      assert.include(decisionOf(yield* Fiber.join(fiber)), '"permissionDecision":"deny"');

      yield* session.cleanup;
    }).pipe(Effect.provide(claudeCodeTestLayer)),
  );

  it.effect("stay refused when the policy denies outside writes", () =>
    Effect.gen(function* () {
      const session = yield* startPolicySession(() => policyWith({ "write-outside": "deny" }));

      const hooked = yield* session.preToolUse(
        "Bash",
        { command: "cd ~ && cat .claude/.credentials.json" },
        "shell-2",
      );

      assert.include(decisionOf(hooked), '"permissionDecision":"deny"');

      yield* session.cleanup;
    }).pipe(Effect.provide(claudeCodeTestLayer)),
  );
});

describe("Claude Code login approvals for long commands", () => {
  it.effect("decline a command too long to show in full instead of asking", () =>
    Effect.gen(function* () {
      const session = yield* startPolicySession(() => policyWith({}));
      const command = `git push --force origin main ${"&& echo ok ".repeat(900)}`;

      const hooked = yield* session.preToolUse("Bash", { command }, "long-1");

      assert.include(decisionOf(hooked), '"permissionDecision":"deny"');
      assert.include(decisionOf(hooked), "too long to show in full");

      yield* session.cleanup;
    }).pipe(Effect.provide(claudeCodeTestLayer)),
  );
});

describe("Claude Code login approvals for MCP tools", () => {
  const issue = {
    owner: "opencoredev",
    repo: "akeru-bot",
    title: "Crash on start",
    body: `Steps to reproduce:\n${"- open the app and wait\n".repeat(30)}Expected: no crash.`,
  };

  it.effect("show the whole input, not a cut summary", () =>
    Effect.gen(function* () {
      const session = yield* startPolicySession(() => policyWith({ "write-outside": "ask" }));

      const fiber = yield* Effect.forkChild(
        session.preToolUse("mcp__github__create_issue", issue, "mcp-1"),
      );

      const opened = yield* nextEvent(session.adapter.streamEvents, "request.opened");

      if (opened.type !== "request.opened" || opened.requestId === undefined) {
        throw new Error("No approval opened.");
      }

      const detail = opened.payload.detail ?? "";
      assert.include(detail, "mcp__github__create_issue");
      assert.include(detail, JSON.stringify(issue, null, 2));
      assert.notProperty(opened.payload.args ?? {}, "command");

      yield* session.adapter.respondToRequest(
        session.threadId,
        ApprovalRequestId.make(opened.requestId),
        "decline",
      );
      yield* Fiber.join(fiber);

      yield* session.cleanup;
    }).pipe(Effect.provide(claudeCodeTestLayer)),
  );

  it.effect("carry no lone command argument that a card could show instead", () =>
    Effect.gen(function* () {
      const session = yield* startPolicySession(() => policyWith({ "write-outside": "ask" }));
      const input = { ...issue, command: "gh issue create" };

      const fiber = yield* Effect.forkChild(
        session.preToolUse("mcp__github__create_issue", input, "mcp-3"),
      );

      const opened = yield* nextEvent(session.adapter.streamEvents, "request.opened");

      if (opened.type !== "request.opened" || opened.requestId === undefined) {
        throw new Error("No approval opened.");
      }

      assert.include(opened.payload.detail ?? "", JSON.stringify(input, null, 2));
      assert.notProperty(opened.payload.args ?? {}, "command");

      yield* session.adapter.respondToRequest(
        session.threadId,
        ApprovalRequestId.make(opened.requestId),
        "decline",
      );
      yield* Fiber.join(fiber);

      yield* session.cleanup;
    }).pipe(Effect.provide(claudeCodeTestLayer)),
  );

  it.effect("decline an input too long to show in full instead of asking", () =>
    Effect.gen(function* () {
      const session = yield* startPolicySession(() => policyWith({ "write-outside": "ask" }));

      const hooked = yield* session.preToolUse(
        "mcp__github__create_issue",
        { ...issue, body: "long line of issue text ".repeat(400) },
        "mcp-2",
      );

      assert.include(decisionOf(hooked), '"permissionDecision":"deny"');
      assert.include(decisionOf(hooked), "too long to show in full");

      yield* session.cleanup;
    }).pipe(Effect.provide(claudeCodeTestLayer)),
  );
});

describe("Claude Code login policy with a relative config folder", () => {
  it.effect("protects the folder the session actually uses", () =>
    Effect.gen(function* () {
      const session = yield* startPolicySession(
        () => policyWith({}),
        [{ name: "CLAUDE_CONFIG_DIR", value: "claude-work", sensitive: false }],
      );

      const signal = new AbortController().signal;
      const settingsFile = NodePath.join(session.home, "claude-work", "settings.json");

      const result = yield* Effect.promise(() =>
        session.canUseTool("Read", { file_path: settingsFile }, { signal, toolUseID: "rel-1" }),
      );

      assert.equal(result.behavior, "deny");
      assert.include(result.behavior === "deny" ? result.message : "", "login or settings");

      yield* session.cleanup;
    }).pipe(Effect.provide(claudeCodeTestLayer)),
  );
});

describe("Claude Code login policy binding", () => {
  it.effect("keeps the policy it started with after the thread's entry is cleared", () =>
    Effect.gen(function* () {
      const session = yield* startPolicySession(() => policyWith({ "environment-access": "deny" }));

      // A stop that finishes after a restart clears the thread's entry.
      clearBotToolPermissionSession(session.threadId);

      const hooked = yield* session.preToolUse("Bash", { command: "ls" }, "bound-1");
      assert.include(decisionOf(hooked), '"permissionDecision":"deny"');
      assert.include(decisionOf(hooked), "not allowed by this bot's permission policy");

      yield* session.cleanup;
    }).pipe(Effect.provide(claudeCodeTestLayer)),
  );

  it.effect("denies every call when the session started without a policy", () =>
    Effect.gen(function* () {
      const session = yield* startPolicySession(() => policyWith({}), undefined, {
        registerPolicy: false,
      });

      const hooked = yield* session.preToolUse(
        "Read",
        { file_path: NodePath.join(session.workspace, "README.md") },
        "unbound-1",
      );

      assert.include(decisionOf(hooked), '"permissionDecision":"deny"');

      yield* session.cleanup;
    }).pipe(Effect.provide(claudeCodeTestLayer)),
  );
});
