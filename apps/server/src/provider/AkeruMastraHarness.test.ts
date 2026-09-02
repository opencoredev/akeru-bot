// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { AuthStorage } from "@mastra/code-sdk/auth/storage";
import { MessageList } from "@mastra/core/agent";
import { RequestContext } from "@mastra/core/request-context";
import { Memory } from "@mastra/memory";
import { ObservationalMemory } from "@mastra/memory/processors";
import {
  AKERU_CREATE_ROUTINE_TOOL_NAME,
  AKERU_PRODUCT_FEEDBACK_TOOL_NAME,
  AKERU_TOOL_CATALOG,
  ProviderDriverKind,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { assert, describe, expect, it, vi } from "vite-plus/test";

import { AKERU_AGENT_INSTRUCTIONS, AKERU_BOT_INSTRUCTIONS } from "./AkeruAgentInstructions.ts";
import {
  AKERU_RECENT_MESSAGE_LIMIT,
  AKERU_DELETE_ROUTINES_TOOL_NAME,
  AKERU_LIST_ROUTINES_TOOL_NAME,
  AkeruPassiveObservationalMemoryProcessor,
  akeruActionNeedsApproval,
  createAkeruObserveHooks,
  createAkeruMastraHarness,
  createAkeruMastraMemory,
  criticalAkeruAction,
  mastraModelId,
  resolveAkeruInstructions,
  resolveAkeruMastraModel,
  resolveAkeruTools,
  routineToolInputSchema,
  routineToolNeedsGlobalApproval,
  withAkeruModelRunOptions,
} from "./AkeruMastraHarness.ts";
import { productFeedbackToolInputSchema } from "./AkeruMastraHarness.ts";
import type { AkeruToolRuntime } from "./AkeruToolRuntime.ts";

describe("Akeru action classifier", () => {
  it.each([
    ["rm -rf .cache", "delete"],
    ["git push origin main", "publish"],
    ["psql -c 'DROP TABLE sessions'", "delete"],
    ["wrangler deploy", "production"],
    ["cat ~/.ssh/id_rsa", "secrets"],
    ['curl -X POST --data \'{"text":"hello"}\' https://example.com/messages', "send"],
    ["cd workspace && git push origin main", "publish"],
    ["find . -name '*.tmp' -delete", "delete"],
    ["git reset --hard HEAD~1", "delete"],
    ["git clean -fd", "delete"],
    ["find . -name '*.tmp' -exec rm -rf {} \\;", "delete"],
    ["python -c 'import os; os.remove(\"tmp.txt\")'", "delete"],
    ["shred important-file", "delete"],
    ["sudo shred -u important-file", "delete"],
    ["command shred -u important-file", "delete"],
    ['bash -c "shred -u important-file"', "delete"],
    ["dd if=/dev/zero of=important-file", "delete"],
    ["sudo dd if=image.img of=/dev/disk4 bs=4m", "delete"],
    ["dd if=/dev/zero > important-file", "delete"],
    ['bash -c "dd if=/dev/zero 1> important-file"', "delete"],
    ["bash -lc 'command shred -u important-file'", "delete"],
    ["printf '%s\\n' important-file | xargs shred -u", "delete"],
    ["printf '%s\\n' important-file | xargs rm -f", "delete"],
    ["printf '%s\\n' empty-dir | xargs rmdir", "delete"],
    ["printf '%s\\n' important-link | xargs unlink", "delete"],
    ["find . -name important-file -exec shred -u {} \\;", "delete"],
    ["printf '%s\\n' important-file | xargs sh -c 'rm -f \"$1\"' _", "delete"],
    ["find . -name important-file -exec sh -c 'rm -f \"$1\"' _ {} \\;", "delete"],
  ] as const)("classifies %s as %s", (command, action) => {
    expect(criticalAkeruAction("execute_command", { command })).toBe(action);
    expect(akeruActionNeedsApproval("execute_command", { command })).toBe(true);
  });

  it.each([
    "bun test",
    "git status",
    "rg -n TODO apps",
    "cat README.md",
    'echo "shred important-file"',
  ])("leaves ordinary local command %s unclassified", (command) => {
    expect(criticalAkeruAction("execute_command", { command })).toBeNull();
    expect(akeruActionNeedsApproval("execute_command", { command })).toBe(false);
  });

  it("requires approval when nested input exceeds the inspection limit", () => {
    let args: unknown = { action: "send" };
    for (let depth = 0; depth < 101; depth += 1) args = { nested: args };

    expect(criticalAkeruAction("custom_tool", args)).toBeNull();
    expect(akeruActionNeedsApproval("custom_tool", args)).toBe(true);
  });
});

describe("AkeruMastraHarness", () => {
  it("emits observer and reflector metering callbacks", async () => {
    const started: unknown[] = [];
    const finished: unknown[] = [];
    const hooks = createAkeruObserveHooks({
      startMemoryCall: async (input) => {
        started.push(input);
        return `${input.category}-call`;
      },
      finishMemoryCall: async (input) => {
        finished.push(input);
      },
    });

    await hooks.onObservationStart?.({ threadId: "thread-1" });
    await hooks.onObservationEnd?.({
      threadId: "thread-1",
      usage: { inputTokens: 10, outputTokens: 5 },
    });
    await hooks.onReflectionStart?.({ threadId: "thread-1" });
    await hooks.onReflectionEnd?.({
      threadId: "thread-1",
      usage: { inputTokens: 20, outputTokens: 8 },
    });

    assert.deepEqual(started, [
      { threadId: "thread-1", category: "observer" },
      { threadId: "thread-1", category: "reflector" },
    ]);
    assert.deepEqual(finished, [
      {
        callId: "observer-call",
        category: "observer",
        usage: { inputTokens: 10, outputTokens: 5 },
      },
      {
        callId: "reflector-call",
        category: "reflector",
        usage: { inputTokens: 20, outputTokens: 8 },
      },
    ]);

    const blocked = createAkeruObserveHooks({
      startMemoryCall: async () => {
        throw new Error("Metering rejected");
      },
    });
    await expect(blocked.onObservationStart?.({ threadId: "thread-1" })).rejects.toThrow(
      "Metering rejected",
    );
  });

  it("stores observational memory by thread and restores it after reopening", async () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-om-store-"));
    const options = {
      authStorage: new AuthStorage(NodePath.join(directory, "auth.json")),
      memoryDbPath: NodePath.join(directory, "observational-memory.sqlite"),
    };
    try {
      const first = await createAkeruMastraMemory(options);
      assert.equal(first.engine.scope, "thread");
      assert.isFalse(first.engine.retrieval);
      await first.memory.createThread({ threadId: "thread-a", resourceId: "resource-a" });
      await first.memory.createThread({ threadId: "thread-b", resourceId: "resource-b" });
      await first.close();

      const reopened = await createAkeruMastraMemory(options);
      assert.deepInclude(
        await reopened.memory.getThreadById({ threadId: "thread-a", resourceId: "resource-a" }),
        { id: "thread-a", resourceId: "resource-a" },
      );
      assert.isNull(
        await reopened.memory.getThreadById({ threadId: "thread-a", resourceId: "resource-b" }),
      );
      await reopened.close();
    } finally {
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("restores a bounded recent message window after reopening", async () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-message-store-"));
    const options = {
      authStorage: new AuthStorage(NodePath.join(directory, "auth.json")),
      memoryDbPath: NodePath.join(directory, "observational-memory.sqlite"),
    };
    try {
      const first = await createAkeruMastraMemory(options);
      await first.memory.createThread({
        threadId: "thread-history",
        resourceId: "thread-history",
      });
      const messages = Array.from({ length: AKERU_RECENT_MESSAGE_LIMIT + 4 }, (_, index) => ({
        id: `message-${index}`,
        role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
        createdAt: DateTime.toDate(
          DateTime.makeUnsafe(`2026-08-30T20:${String(index).padStart(2, "0")}:00.000Z`),
        ),
        content: { format: 2 as const, parts: [{ type: "text" as const, text: `Turn ${index}` }] },
        threadId: "thread-history",
        resourceId: "thread-history",
      }));
      await first.memory.persistMessages(messages);
      await first.close();

      const reopened = await createAkeruMastraMemory(options);
      const engine = {
        getThreadContext: vi.fn(() => ({
          threadId: "thread-history",
          resourceId: "thread-history",
        })),
        getOrCreateRecord: vi.fn(async () => ({ activeObservations: "Older observations." })),
        buildContextSystemMessages: vi.fn(async () => ["Older context from observations."]),
      } as unknown as ObservationalMemory;
      const processor = new AkeruPassiveObservationalMemoryProcessor(engine, reopened.memory);
      const messageList = new MessageList({
        threadId: "thread-history",
        resourceId: "thread-history",
      });
      messageList.add(
        {
          id: "current-message",
          role: "user",
          createdAt: DateTime.toDate(DateTime.makeUnsafe("2026-08-31T20:00:00.000Z")),
          content: { format: 2, parts: [{ type: "text", text: "What did we discuss?" }] },
          threadId: "thread-history",
          resourceId: "thread-history",
        },
        "input",
      );

      await processor.processInputStep({ stepNumber: 0, messageList } as never);

      const recalled = messageList.get.remembered.db();
      assert.equal(recalled.length, AKERU_RECENT_MESSAGE_LIMIT);
      assert.deepEqual(
        recalled.map((message) => message.id),
        messages.slice(-AKERU_RECENT_MESSAGE_LIMIT).map((message) => message.id),
      );
      assert.deepEqual(
        messageList.getSystemMessages("observational-memory").map((message) => message.content),
        ["Older context from observations."],
      );
      assert.equal(messageList.get.input.db()[0]?.id, "current-message");
      await reopened.close();
    } finally {
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("adds older observational context beside the recent message window", async () => {
    const engine = {
      getThreadContext: vi.fn(() => ({ threadId: "thread-context", resourceId: "thread-context" })),
      getOrCreateRecord: vi.fn(async () => ({
        activeObservations: "The user prefers short replies.",
      })),
      buildContextSystemMessages: vi.fn(async () => ["Older context: short replies."]),
    } as unknown as ObservationalMemory;
    const processor = new AkeruPassiveObservationalMemoryProcessor(engine, {
      recall: vi.fn(async () => ({ messages: [] })),
      persistMessages: vi.fn(async () => undefined),
    } as unknown as Memory);
    const messageList = new MessageList({
      threadId: "thread-context",
      resourceId: "thread-context",
    });
    messageList.add(
      {
        id: "recent-message",
        role: "user",
        createdAt: DateTime.toDate(DateTime.makeUnsafe("2026-08-31T20:00:00.000Z")),
        content: { format: 2, parts: [{ type: "text", text: "Use the context you remember." }] },
        threadId: "thread-context",
        resourceId: "thread-context",
      },
      "input",
    );

    await processor.processInputStep({ stepNumber: 0, messageList } as never);

    assert.deepEqual(
      messageList.getSystemMessages("observational-memory").map((message) => message.content),
      ["Older context: short replies."],
    );
    assert.lengthOf(messageList.get.input.db(), 1);
    assert.equal(messageList.get.input.db()[0]?.id, "recent-message");
  });

  it("persists only messages created by the current turn", async () => {
    const persistMessages = vi.fn(async () => undefined);
    const engine = {
      getThreadContext: vi.fn(() => ({ threadId: "thread-passive", resourceId: "thread-passive" })),
      getOrCreateRecord: vi.fn(async () => ({ activeObservations: "" })),
      buildContextSystemMessages: vi.fn(async () => []),
    } as unknown as ObservationalMemory;
    const processor = new AkeruPassiveObservationalMemoryProcessor(engine, {
      persistMessages,
    } as unknown as Memory);
    const messageList = new MessageList({
      threadId: "thread-passive",
      resourceId: "thread-passive",
    });
    messageList.add(
      {
        id: "user-history",
        role: "user",
        createdAt: DateTime.toDate(DateTime.makeUnsafe("2026-08-30T20:00:00.000Z")),
        content: { format: 2, parts: [{ type: "text", text: "Earlier turn." }] },
        threadId: "thread-passive",
        resourceId: "thread-passive",
      },
      "memory",
    );
    for (const message of [
      {
        id: "user-current",
        role: "user" as const,
        text: "Only this turn.",
        source: "input" as const,
      },
      {
        id: "assistant-current",
        role: "assistant" as const,
        text: "Current reply.",
        source: "response" as const,
      },
    ]) {
      messageList.add(
        {
          id: message.id,
          role: message.role,
          createdAt: DateTime.toDate(DateTime.makeUnsafe("2026-08-31T20:00:00.000Z")),
          content: { format: 2, parts: [{ type: "text", text: message.text }] },
          threadId: "thread-passive",
          resourceId: "thread-passive",
        },
        message.source,
      );
    }

    await processor.processOutputResult({ messageList } as never);

    expect(persistMessages).toHaveBeenCalledOnce();
    expect(persistMessages).toHaveBeenCalledWith([
      expect.objectContaining({ id: "user-current" }),
      expect.objectContaining({ id: "assistant-current" }),
    ]);
  });

  it("serializes observations per thread and drains them before close", async () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-om-queue-"));
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let markStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let calls = 0;
    const observe = vi
      .spyOn(ObservationalMemory.prototype, "observe")
      .mockImplementation(async () => {
        calls += 1;
        if (calls === 1) {
          markStarted();
          await firstBlocked;
        }
        return undefined as never;
      });
    const harness = await createAkeruMastraHarness({
      authStorage: new AuthStorage(NodePath.join(directory, "auth.json")),
      memoryDbPath: NodePath.join(directory, "observational-memory.sqlite"),
      getThreadTools: () => ({}),
      toolRuntime: { toolsForThread: () => [] } as unknown as AkeruToolRuntime,
    });
    try {
      const input = { threadId: "thread-queue", modelId: "openai/gpt-5.6-sol" };
      const first = harness.observeAfterTurn!(input);
      await firstStarted;
      const second = harness.observeAfterTurn!(input);
      expect(observe).toHaveBeenCalledOnce();
      const close = harness.destroy();
      releaseFirst();
      await Promise.all([first, second, close]);
      expect(observe).toHaveBeenCalledTimes(2);
    } finally {
      releaseFirst();
      observe.mockRestore();
      await harness.destroy();
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps Kimi model names on the Kimi subscription transport", () => {
    const authStorage = new AuthStorage("/tmp/akeru-unused-auth.json");
    assert.equal(
      mastraModelId(ProviderDriverKind.make("kimi"), "k3-256k"),
      "kimi-for-coding/k3-256k",
    );
    assert.deepInclude(
      resolveAkeruMastraModel("kimi-for-coding/k3-256k", authStorage, async () => ({
        accessToken: "kimi-access",
        deviceId: "0123456789abcdef0123456789abcdef",
      })),
      { provider: "anthropic.messages", modelId: "k3-256k" },
    );
    assert.throws(
      () => resolveAkeruMastraModel("kimi-for-coding/k3-256k", authStorage),
      "subscription access is unavailable",
    );
  });

  it("passes the saved Codex service tier to Mastra provider options", () => {
    expect(
      withAkeruModelRunOptions(
        { providerOptions: { anthropic: { fallback: true }, openai: { store: false } } },
        { modelOptions: { serviceTier: "priority" } },
      ),
    ).toEqual({
      providerOptions: {
        anthropic: { fallback: true },
        openai: { store: false, serviceTier: "priority" },
      },
    });
  });

  it("configures Akeru as a general-purpose assistant with plugin awareness", () => {
    assert.include(AKERU_AGENT_INSTRUCTIONS, "general-purpose assistant");
    assert.include(AKERU_AGENT_INSTRUCTIONS, "enabled plugin tools");
    assert.include(AKERU_AGENT_INSTRUCTIONS, "Prefer preview_* tools over browser_* tools");
    assert.include(AKERU_AGENT_INSTRUCTIONS, "akeru_list_routines");
    assert.include(AKERU_AGENT_INSTRUCTIONS, "Do not assume");
    assert.notInclude(AKERU_AGENT_INSTRUCTIONS, "coding agent");
  });

  it("adds reply and status rules only to bot conversations", () => {
    const regular = new RequestContext();
    regular.setRaw("controller", { state: { botConversation: false } });
    const bot = new RequestContext();
    bot.setRaw("controller", { state: { botConversation: true } });

    assert.equal(resolveAkeruInstructions(regular), AKERU_AGENT_INSTRUCTIONS);
    assert.equal(resolveAkeruInstructions(bot), AKERU_BOT_INSTRUCTIONS);
    assert.include(resolveAkeruInstructions(bot), "Before you use a tool");
    assert.include(resolveAkeruInstructions(bot), "automatic continuation");
  });

  it("selects implemented runtime tools without dropping approval-aware plugins", async () => {
    const requestContext = new RequestContext();
    requestContext.setRaw("controller", {
      resourceId: "thread-1",
      session: { modelId: "openai/gpt-5.6-sol" },
    });
    const approvalInputs: unknown[] = [];
    const runtime = {
      toolsForThread: () => AKERU_TOOL_CATALOG.filter((tool) => tool.id === "Shell"),
      requiresApproval: async (_threadId: string, _toolId: string, input: unknown) => {
        approvalInputs.push(input);
        return true;
      },
      execute: async () => undefined,
    } as unknown as AkeruToolRuntime;
    const pluginTool = { id: "plugin", execute: async () => undefined, requireApproval: false };
    const approvalPolicies: boolean[] = [];

    const tools = await resolveAkeruTools(requestContext, {
      authStorage: new AuthStorage("/tmp/akeru-unused-auth.json"),
      getThreadTools: () => ({
        exa_search: pluginTool,
        RestartMcpServers: pluginTool,
        Shell: pluginTool,
      }),
      syncThreadToolApproval: async (_threadId, _toolName, protectedAction) => {
        approvalPolicies.push(protectedAction);
      },
      toolRuntime: runtime,
    });

    assert.containsAllKeys(tools, [
      "Shell",
      "exa_search",
      "RestartMcpServers",
      AKERU_PRODUCT_FEEDBACK_TOOL_NAME,
    ]);
    assert.notProperty(tools, "Read");
    assert.notProperty(tools, "execute_command");
    const shell = tools.Shell as unknown as {
      readonly needsApprovalFn: (input: unknown) => Promise<boolean>;
    };
    const restart = tools.RestartMcpServers as unknown as {
      readonly needsApprovalFn: (input: unknown) => Promise<boolean>;
    };
    const search = tools.exa_search as unknown as {
      readonly needsApprovalFn: (input: unknown) => Promise<boolean>;
    };
    assert.isTrue(await restart.needsApprovalFn({}));
    assert.isTrue(await search.needsApprovalFn({ operation: "send" }));
    assert.isTrue(await search.needsApprovalFn({ command: "git push origin main" }));
    assert.isTrue(await search.needsApprovalFn({ path: ".env" }));
    assert.isFalse(await search.needsApprovalFn({ operation: "read" }));
    assert.isTrue(
      await shell.needsApprovalFn({ command: 'printf "hi\\n"', cwd: null, background: null }),
    );
    assert.deepEqual(approvalInputs, [{ command: 'printf "hi\\n"' }]);
    assert.deepEqual(approvalPolicies, [true, true, true, true, false]);
    assert.equal(criticalAkeruAction("RestartMcpServers"), "production");
  });

  it("keeps product feedback draft-only and approval-gated", async () => {
    const valid = await productFeedbackToolInputSchema["~standard"].validate({
      feedback: "The button is unresponsive.",
    });
    const forbidden = await productFeedbackToolInputSchema["~standard"].validate({
      feedback: "Private payload",
      conversation: "full thread",
    });
    assert.isUndefined(valid.issues);
    assert.isDefined(forbidden.issues);

    const requestContext = new RequestContext();
    requestContext.setRaw("controller", { resourceId: "thread-1" });
    const tools = await resolveAkeruTools(requestContext, {
      authStorage: new AuthStorage("/tmp/akeru-unused-auth.json"),
      getThreadTools: () => ({}),
      toolRuntime: { toolsForThread: () => [] } as unknown as AkeruToolRuntime,
    });
    const tool = tools[AKERU_PRODUCT_FEEDBACK_TOOL_NAME] as {
      requireApproval?: boolean;
      execute?: (input: unknown, context: unknown) => Promise<unknown>;
    };
    assert.isTrue(tool.requireApproval);
    assert.deepEqual(await tool.execute?.({ feedback: "The button is unresponsive." }, {}), {
      status: "draft-opened",
    });
  });

  it("awaits observational-memory hooks", async () => {
    const finished: unknown[] = [];
    const hooks = createAkeruObserveHooks({
      startMemoryCall: async ({ category }) => `${category}-call`,
      finishMemoryCall: async (input) => {
        finished.push(input);
      },
    });

    await hooks.onObservationStart?.({ threadId: "thread-1" });
    await hooks.onObservationEnd?.({
      threadId: "thread-1",
      usage: { inputTokens: 10, outputTokens: 5 },
    });
    await hooks.onReflectionStart?.({ threadId: "thread-1" });
    await hooks.onReflectionEnd?.({
      threadId: "thread-1",
      usage: { inputTokens: 20, outputTokens: 8 },
    });

    assert.deepEqual(finished, [
      {
        callId: "observer-call",
        category: "observer",
        usage: { inputTokens: 10, outputTokens: 5 },
      },
      {
        callId: "reflector-call",
        category: "reflector",
        usage: { inputTokens: 20, outputTokens: 8 },
      },
    ]);

    const blocked = createAkeruObserveHooks({
      startMemoryCall: async () => {
        throw new Error("Hook rejected");
      },
    });
    let blockedError: unknown;
    try {
      await blocked.onObservationStart?.({ threadId: "thread-1" });
    } catch (error) {
      blockedError = error;
    }
    assert.instanceOf(blockedError, Error);
    assert.equal(blockedError.message, "Hook rejected");
  });

  it("creates an approved routine for the current chat after tool approval", async () => {
    assert.isFalse(routineToolNeedsGlobalApproval(AKERU_CREATE_ROUTINE_TOOL_NAME));
    assert.isFalse(routineToolNeedsGlobalApproval(AKERU_LIST_ROUTINES_TOOL_NAME));
    assert.isTrue(routineToolNeedsGlobalApproval("execute_command"));
    assert.isTrue(
      routineToolInputSchema.safeParse({
        name: "Morning brief",
        instructions: "Prepare the morning brief.",
        schedule: { kind: "weekdays", time: "09:00" },
      }).success,
    );
    assert.isTrue(
      routineToolInputSchema.safeParse({
        name: "Morning brief",
        instructions: "Prepare the morning brief.",
        schedule: { kind: "weekdays", time: "09:00" },
        connectorNames: null,
      }).success,
    );
    assert.isFalse(
      routineToolInputSchema.safeParse({
        name: "Morning brief",
        instructions: "Prepare the morning brief.",
        schedule: { kind: "weekdays", time: {} },
      }).success,
    );
    const calls: unknown[] = [];
    const requestContext = new RequestContext();
    requestContext.setRaw("controller", { resourceId: "thread-1" });
    const tools = await resolveAkeruTools(requestContext, {
      authStorage: new AuthStorage("/tmp/akeru-unused-auth.json"),
      getThreadTools: () => ({}),
      toolRuntime: { toolsForThread: () => [] } as unknown as AkeruToolRuntime,
      createRoutine: async (threadId, input) => {
        calls.push({ threadId, input });
        return { status: "approved" };
      },
    });
    const tool = tools[AKERU_CREATE_ROUTINE_TOOL_NAME] as {
      requireApproval?: boolean;
      execute?: (input: unknown, context: unknown) => Promise<unknown>;
    };

    assert.isFalse(tool.requireApproval);
    assert.deepEqual(calls, []);
    assert.deepEqual(
      await tool.execute?.(
        {
          name: "Morning brief",
          instructions: "Prepare the morning brief.",
          schedule: { kind: "weekdays", time: "09:00" },
          skillNames: null,
          connectorNames: null,
        },
        {},
      ),
      { status: "approved" },
    );
    assert.deepEqual(calls, [
      {
        threadId: "thread-1",
        input: {
          name: "Morning brief",
          instructions: "Prepare the morning brief.",
          schedule: { kind: "weekdays", time: "09:00" },
        },
      },
    ]);
  });

  it("lets the model inspect this bot's routine states without approval", async () => {
    const calls: string[] = [];
    const requestContext = new RequestContext();
    requestContext.setRaw("controller", { resourceId: "thread-1" });
    const result = {
      routines: [
        { id: "routine-1", name: "Morning brief", enabled: true, lifecycle: "enabled" as const },
        {
          id: "routine-2",
          name: "Weekly review",
          enabled: false,
          lifecycle: "approved" as const,
        },
        {
          id: "routine-3",
          name: "Inbox check",
          enabled: false,
          lifecycle: "paused" as const,
        },
      ],
    };
    const tools = await resolveAkeruTools(requestContext, {
      authStorage: new AuthStorage("/tmp/akeru-unused-auth.json"),
      getThreadTools: () => ({}),
      toolRuntime: { toolsForThread: () => [] } as unknown as AkeruToolRuntime,
      listRoutines: async (threadId) => {
        calls.push(threadId);
        return result;
      },
    });
    const tool = tools[AKERU_LIST_ROUTINES_TOOL_NAME] as {
      requireApproval?: boolean;
      execute?: (input: unknown, context: unknown) => Promise<unknown>;
    };

    assert.deepEqual(calls, []);
    assert.isFalse(tool.requireApproval);
    assert.deepEqual(await tool.execute?.({}, {}), result);
    assert.deepEqual(calls, ["thread-1"]);
  });

  it("asks once before deleting one or more routines", async () => {
    const deleted: Array<{ threadId: string; routineIds: ReadonlyArray<string> }> = [];
    const suspended: unknown[] = [];
    const requestContext = new RequestContext();
    requestContext.setRaw("controller", { resourceId: "thread-1" });
    const tools = await resolveAkeruTools(requestContext, {
      authStorage: new AuthStorage("/tmp/akeru-unused-auth.json"),
      getThreadTools: () => ({}),
      toolRuntime: { toolsForThread: () => [] } as unknown as AkeruToolRuntime,
      listRoutines: async () => ({
        routines: [
          { id: "routine-1", name: "Morning brief", enabled: true, lifecycle: "enabled" },
          { id: "routine-2", name: "Weekly review", enabled: false, lifecycle: "paused" },
        ],
      }),
      deleteRoutines: async (threadId, routineIds) => {
        deleted.push({ threadId, routineIds });
        return { status: "deleted", deletedRoutineIds: [...routineIds] };
      },
    });
    const tool = tools[AKERU_DELETE_ROUTINES_TOOL_NAME] as {
      requireApproval?: boolean;
      execute?: (input: unknown, context: unknown) => Promise<unknown>;
    };
    const input = { routineIds: ["routine-1", "routine-2"] };

    assert.isFalse(tool.requireApproval);
    assert.deepEqual(deleted, []);
    await tool.execute?.(input, {
      agent: { suspend: async (payload: unknown) => void suspended.push(payload) },
    });
    assert.deepEqual(deleted, []);
    assert.deepEqual(suspended, [
      {
        question:
          'Are you sure you want to delete these routines: "Morning brief", "Weekly review"?',
        options: [
          {
            label: "Delete routines",
            description: "Stop these schedules and hide them from the routines list.",
          },
          { label: "Cancel", description: "Keep every routine." },
        ],
        selectionMode: "single_select",
      },
    ]);

    assert.deepEqual(await tool.execute?.(input, { agent: { resumeData: "Cancel" } }), {
      status: "cancelled",
      deletedRoutineIds: [],
    });
    assert.deepEqual(deleted, []);
    assert.deepEqual(await tool.execute?.(input, { agent: { resumeData: "Delete routines" } }), {
      status: "deleted",
      deletedRoutineIds: ["routine-1", "routine-2"],
    });
    assert.deepEqual(deleted, [{ threadId: "thread-1", routineIds: ["routine-1", "routine-2"] }]);
  });

  it("does not ask or delete when any requested routine is unavailable", async () => {
    let suspended = false;
    let deleted = false;
    const requestContext = new RequestContext();
    requestContext.setRaw("controller", { resourceId: "thread-1" });
    const tools = await resolveAkeruTools(requestContext, {
      authStorage: new AuthStorage("/tmp/akeru-unused-auth.json"),
      getThreadTools: () => ({}),
      toolRuntime: { toolsForThread: () => [] } as unknown as AkeruToolRuntime,
      listRoutines: async () => ({ routines: [] }),
      deleteRoutines: async () => {
        deleted = true;
        return { status: "deleted", deletedRoutineIds: [] };
      },
    });
    const tool = tools[AKERU_DELETE_ROUTINES_TOOL_NAME] as {
      execute?: (input: unknown, context: unknown) => Promise<unknown>;
    };

    assert.deepEqual(
      await tool.execute?.(
        { routineIds: ["missing-routine"] },
        { agent: { suspend: async () => void (suspended = true) } },
      ),
      { status: "not-found", deletedRoutineIds: [] },
    );
    assert.isFalse(suspended);
    assert.isFalse(deleted);
  });
});
