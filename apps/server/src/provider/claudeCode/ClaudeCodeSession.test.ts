import {
  type HookCallbackMatcher,
  type Options as ClaudeQueryOptions,
  type PermissionResult,
  type SDKUserMessage,
  type SpawnOptions,
} from "@anthropic-ai/claude-agent-sdk";
import { ApprovalRequestId, BotId, EnvironmentId, ThreadId } from "@akeru/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";

import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import { createClaudeCodeQuery } from "../Layers/claude/ClaudeCodeProcess.ts";
import {
  FakeClaudeQuery,
  readFirstPromptText,
} from "../Layers/test-support/claudeAdapterHarness.ts";
import {
  CLAUDE_CODE_INSTANCE_ID as INSTANCE_ID,
  claudeCodeTestLayer as testLayer,
  makeClaudeCodeAdapter,
  nextEvent,
  policyWith,
  silentProcess,
} from "../Layers/test-support/claudeCodeAdapterHarness.ts";
import {
  clearBotToolPermissionSession,
  setBotToolPermissionSession,
} from "../tools/BotToolPermissionSessions.ts";
import { CLAUDE_CODE_DRIVER_KIND } from "./ClaudeCodeLogin.ts";

const BOT_ID = BotId.make("bot-ada");

describe("Claude Code login sessions", () => {
  it.effect("starts Claude Code without any token or API key in its environment", () =>
    Effect.gen(function* () {
      const spawned: SpawnOptions[] = [];

      const adapter = yield* makeClaudeCodeAdapter((input) =>
        createClaudeCodeQuery({
          ...input,
          spawnProcess: (spawnOptions) => {
            spawned.push(spawnOptions);

            return silentProcess();
          },
        }),
      );

      const threadId = ThreadId.make("thread-claude-code-env");
      yield* adapter.startSession({
        threadId,
        provider: CLAUDE_CODE_DRIVER_KIND,
        runtimeMode: "approval-required",
      });

      const spawnedEnvironment = spawned[0]?.env;
      assert.isDefined(spawnedEnvironment);
      assert.equal(spawned[0]?.command, "/opt/claude/bin/claude");

      // Only allowlisted variables cross, from the server and the instance alike.
      for (const key of [
        "CLAUDE_CODE_OAUTH_TOKEN",
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_AUTH_TOKEN",
        "ANTHROPIC_BASE_URL",
        "ANTHROPIC_CUSTOM_HEADERS",
        "ANTHROPIC_BETAS",
        "CLAUDE_CODE_SIMPLE",
        "CLAUDE_CODE_USE_BEDROCK",
        "CLAUDE_CODE_USE_VERTEX",
        "CLAUDE_CODE_USE_FOUNDRY",
        "AWS_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY",
        "GOOGLE_APPLICATION_CREDENTIALS",
        "CLAUDE_CONFIG_DIR",
        "AKERU_CLAUDE_PATH",
      ]) {
        assert.notProperty(spawnedEnvironment, key);
      }

      const sdkOwned = new Set(["CLAUDE_AGENT_SDK_VERSION", "CLAUDE_CODE_ENTRYPOINT"]);

      assert.deepEqual(
        Object.keys(spawnedEnvironment ?? {})
          .filter((key) => !sdkOwned.has(key))
          .sort(),
        [
          "CLAUDE_AGENT_SDK_CLIENT_APP",
          "HOME",
          "HTTPS_PROXY",
          "LANG",
          "LC_ALL",
          "NODE_EXTRA_CA_CERTS",
          "PATH",
          "no_proxy",
        ],
      );

      assert.match(spawnedEnvironment?.CLAUDE_AGENT_SDK_CLIENT_APP ?? "", /^akeru-bot\//);
      assert.notMatch(JSON.stringify(spawned[0]?.args ?? []), /claude-code-20250219|oauth/);

      yield* adapter.stopSession(threadId);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("passes bot instructions, memory, Akeru's MCP server, and the policy hook", () =>
    Effect.gen(function* () {
      const fake = new FakeClaudeQuery();

      let created:
        | { readonly prompt: AsyncIterable<SDKUserMessage>; readonly options: ClaudeQueryOptions }
        | undefined;

      const adapter = yield* makeClaudeCodeAdapter((input) => {
        created = input;

        return fake;
      });

      const threadId = ThreadId.make("thread-claude-code-wiring");

      McpProviderSession.setMcpProviderSession({
        environmentId: EnvironmentId.make("local"),
        threadId,
        providerSessionId: "mcp-session-1",
        providerInstanceId: INSTANCE_ID,
        endpoint: "http://127.0.0.1:4100/mcp",
        authorizationHeader: "Bearer per-session-credential",
      });

      const session = yield* adapter.startSession({
        threadId,
        provider: CLAUDE_CODE_DRIVER_KIND,
        runtimeMode: "full-access",
        botId: BOT_ID,
        botName: "Ada",
        persistentMemoryContext: "<bot-memory>Ada prefers short replies.</bot-memory>",
      });

      assert.equal(session.provider, CLAUDE_CODE_DRIVER_KIND);
      const options = created?.options;
      assert.isDefined(options);

      const systemPrompt = options?.systemPrompt;
      assert.isTrue(Predicate.isObject(systemPrompt) && !Array.isArray(systemPrompt));

      const append =
        Predicate.isObject(systemPrompt) && "append" in systemPrompt
          ? String(systemPrompt.append)
          : "";

      assert.include(append, "Ada");
      assert.include(append, "Ada prefers short replies.");

      assert.deepEqual(options?.mcpServers?.akeru, {
        type: "http",
        url: "http://127.0.0.1:4100/mcp",
        headers: { Authorization: "Bearer per-session-credential" },
      });
      assert.equal(options?.strictMcpConfig, true);

      const preToolUse: ReadonlyArray<HookCallbackMatcher> = options?.hooks?.PreToolUse ?? [];
      assert.equal(preToolUse.length, 1);

      yield* adapter.sendTurn({
        threadId,
        input: "What changed?",
        persistentMemoryContext: "<memory-review>Check the release notes.</memory-review>",
      });

      const prompt = yield* Effect.promise(() => readFirstPromptText(created));
      assert.include(prompt ?? "", "<akeru-turn-context>");
      assert.include(prompt ?? "", "Check the release notes.");

      McpProviderSession.clearMcpProviderSession(threadId);
      yield* adapter.stopSession(threadId);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("denies, asks the owner, and re-checks the policy before a call runs", () =>
    Effect.gen(function* () {
      const fake = new FakeClaudeQuery();
      let options: ClaudeQueryOptions | undefined;

      const adapter = yield* makeClaudeCodeAdapter((input) => {
        options = input.options;

        return fake;
      });

      const threadId = ThreadId.make("thread-claude-code-policy");
      let policy = policyWith({ "environment-access": "deny" });

      setBotToolPermissionSession(threadId, {
        botId: BOT_ID,
        permissions: {
          principal: { kind: "owner" },
          policy,
          readPolicy: async () => policy,
        },
      });

      yield* adapter.startSession({
        threadId,
        provider: CLAUDE_CODE_DRIVER_KIND,
        runtimeMode: "full-access",
        botId: BOT_ID,
        cwd: "/tmp/claude-code-session-test",
      });

      const canUseTool = options?.canUseTool;
      const hook = options?.hooks?.PreToolUse?.[0]?.hooks[0];
      assert.isDefined(canUseTool);
      assert.isDefined(hook);

      if (!canUseTool || !hook) return;

      const signal = new AbortController().signal;

      // Deny: the policy stops the shell even in Full access.
      const denied = yield* Effect.promise(() =>
        canUseTool("Bash", { command: "ls" }, { signal, toolUseID: "tool-deny" }),
      );

      assert.equal(denied.behavior, "deny");

      const hookDenied = yield* Effect.promise(() =>
        hook(
          {
            hook_event_name: "PreToolUse",
            session_id: "s",
            transcript_path: "/tmp/t",
            cwd: "/tmp",
            tool_name: "Bash",
            tool_input: { command: "ls" },
            tool_use_id: "tool-deny-hook",
          },
          "tool-deny-hook",
          { signal },
        ),
      );

      assert.deepInclude(JSON.stringify(hookDenied), '"permissionDecision":"deny"');

      // Allow: a workspace edit follows the chat's mode.
      const allowed = yield* Effect.promise(() =>
        canUseTool("Edit", { file_path: "a.ts" }, { signal, toolUseID: "tool-allow" }),
      );

      assert.equal(allowed.behavior, "allow");

      // Ask: outside writes wait for the owner, even in Full access.
      policy = policyWith({ "write-outside": "ask" });

      const asked = canUseTool(
        "Bash",
        { command: "git push --force" },
        { signal, toolUseID: "tool-ask" },
      );

      const opened = yield* nextEvent(adapter.streamEvents, "request.opened");
      assert.equal(opened.type, "request.opened");

      if (opened.type !== "request.opened" || opened.requestId === undefined) return;

      assert.deepEqual(
        opened.payload.options?.map((option) => option.decision),
        ["decline", "accept"],
      );

      // The owner approves, but the policy was tightened while the prompt waited.
      policy = policyWith({ "write-outside": "deny" });
      yield* adapter.respondToRequest(threadId, ApprovalRequestId.make(opened.requestId), "accept");

      const revoked: PermissionResult = yield* Effect.promise(() => asked);
      assert.equal(revoked.behavior, "deny");

      // With the policy back to ask, the owner's approval lets the call run once.
      policy = policyWith({ "write-outside": "ask" });

      const approvedCall = canUseTool(
        "Bash",
        { command: "git push --force" },
        { signal, toolUseID: "tool-ask-2" },
      );

      const reopened = yield* nextEvent(adapter.streamEvents, "request.opened");

      if (reopened.type !== "request.opened" || reopened.requestId === undefined) return;

      yield* adapter.respondToRequest(
        threadId,
        ApprovalRequestId.make(reopened.requestId),
        "accept",
      );

      const approved: PermissionResult = yield* Effect.promise(() => approvedCall);
      assert.equal(approved.behavior, "allow");

      clearBotToolPermissionSession(threadId);
      yield* adapter.stopSession(threadId);
    }).pipe(Effect.provide(testLayer)),
  );
});
