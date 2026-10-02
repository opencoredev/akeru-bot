import * as Predicate from "effect/Predicate";
import { describe } from "vite-plus/test";
import {
  DelegationId,
  McpServerId,
  MessageId,
  ThreadId,
  TurnId,
  AkeruDelegationRecord,
  AkeruToolInputSchemas,
  type OrchestrationCommand,
} from "@akeru/contracts";
import * as Schema from "effect/Schema";
import { expect, it } from "vite-plus/test";
import {
  createAkeruDelegationRuntime,
  type AkeruDelegationChildOutcome,
} from "./AkeruDelegationRuntime.ts";
import { intersectDelegationAccess } from "./AkeruToolRuntime.ts";
import {
  CHILD_BOT_ID,
  CHILD_TURN_ID,
  NOW,
  PARENT_BOT_ID,
  PARENT_THREAD_ID,
  PARENT_TURN_ID,
  access,
  delegation,
  harness,
  parent,
  request,
  snapshot,
  thread,
} from "./testUtils/delegationHarness.ts";

const encodeDelegationRecord = Schema.encodeUnknownSync(AkeruDelegationRecord);

const decodeDelegationRecord = Schema.decodeUnknownSync(AkeruDelegationRecord);

const decodeSendToAgent = Schema.decodeUnknownSync(AkeruToolInputSchemas.SendToAgent);

describe("delegation access", () => {
  it("intersects MCP disables, user-computer capability, tools, and memory scopes", () => {
    const grant = intersectDelegationAccess({
      parent: access({
        allowedToolIds: ["Read", "ExternalRead", "SendToAgent"],
        memoryScopes: ["private", "project"],
        hasUserComputer: false,
        enabledMcpServerIds: [McpServerId.make("web"), McpServerId.make("email")],
        disabledMcpServerIds: [McpServerId.make("parent-disabled")],
      }),
      child: access({
        allowedToolIds: ["Read", "ExternalRead"],
        memoryScopes: ["project", "group"],
        hasUserComputer: true,
        enabledMcpServerIds: [McpServerId.make("web")],
        disabledMcpServerIds: [McpServerId.make("child-disabled")],
      }),
      requested: request({
        allowedToolIds: ["Read", "ExternalRead"],
        memoryScopes: ["project"],
        mcpServerIds: [McpServerId.make("web"), McpServerId.make("email")],
      }) as never,
    });

    expect(grant).toMatchObject({
      allowedToolIds: ["Read", "ExternalRead"],
      memoryScopes: ["project"],
      hasUserComputer: false,
      enabledMcpServerIds: ["web"],
      disabledMcpServerIds: ["parent-disabled", "child-disabled"],
    });
  });
});

describe("AkeruDelegationRuntime", () => {
  it("sends a bot message through its active thread", async () => {
    const test = harness(
      snapshot({
        threads: [
          thread(PARENT_THREAD_ID, PARENT_BOT_ID, {
            latestTurn: {
              turnId: PARENT_TURN_ID,
              state: "running",
              requestedAt: NOW,
              startedAt: NOW,
              completedAt: null,
              assistantMessageId: null,
            },
          }),
        ],
      }),
    );

    await expect(
      test.runtime.sendToUser(parent(), { message: "The export is ready." }),
    ).resolves.toMatchObject({
      toolId: "SendToUser",
      phase: "success",
      threadId: PARENT_THREAD_ID,
      botId: PARENT_BOT_ID,
    });
    expect(test.commands.slice(-2)).toMatchObject([
      {
        type: "thread.message.assistant.delta",
        threadId: PARENT_THREAD_ID,
        turnId: PARENT_TURN_ID,
        delta: "The export is ready.",
      },
      {
        type: "thread.message.assistant.complete",
        threadId: PARENT_THREAD_ID,
        turnId: PARENT_TURN_ID,
      },
    ]);
  });

  it("persists a completed record that decodes with the child turn", async () => {
    const test = harness();
    await test.runtime.send(parent(), request() as never);
    await test.runtime.drain();

    const persisted = test.state.delegations.at(-1);
    const encoded = encodeDelegationRecord(persisted);
    const decoded = decodeDelegationRecord(encoded);
    expect(decoded.phase).toMatchObject({
      _tag: "Completed",
      childTurnId: CHILD_TURN_ID,
      result: { summary: "The delegated answer.", childTurnId: CHILD_TURN_ID },
    });
  });

  it("anchors the record on the parent turn's user message", async () => {
    const latestTurn = (turnId: TurnId) => ({
      turnId,
      state: "running" as const,
      requestedAt: NOW,
      startedAt: NOW,
      completedAt: null,
      assistantMessageId: null,
      requestMessageId: MessageId.make("message-user"),
    });

    const anchored = harness(
      snapshot({
        threads: [
          thread(PARENT_THREAD_ID, PARENT_BOT_ID, { latestTurn: latestTurn(PARENT_TURN_ID) }),
        ],
      }),
    );

    await anchored.runtime.send(parent(), request() as never);
    expect(anchored.state.delegations.at(-1)).toMatchObject({
      anchorMessageId: "message-user",
      retryOfDelegationId: null,
      trigger: "bot",
    });

    const otherTurn = harness(
      snapshot({
        threads: [
          thread(PARENT_THREAD_ID, PARENT_BOT_ID, {
            latestTurn: latestTurn(TurnId.make("turn-other")),
          }),
        ],
      }),
    );

    await otherTurn.runtime.send(parent(), request() as never);
    expect(otherTurn.state.delegations.at(-1)?.anchorMessageId).toBeNull();
  });

  it("keeps work a bot sent with keep running after its turn ends", async () => {
    const test = harness();
    const child = Promise.withResolvers<AkeruDelegationChildOutcome>();

    const runtime = createAkeruDelegationRuntime({
      readSnapshot: async () => test.state,
      dispatch: test.dispatch,
      awaitChild: () => child.promise,
      interruptChild: async () => undefined,
      now: () => NOW,
      id: (() => {
        let next = 100;

        return () => String(++next);
      })(),
    });

    const input = decodeSendToAgent(request({ keep: true }));

    const handle = await runtime.send(parent(), input);
    expect(test.state.delegations.at(-1)).toMatchObject({ keep: true });

    await runtime.parentFinished({
      threadId: PARENT_THREAD_ID,
      turnId: PARENT_TURN_ID,
      failed: false,
    });
    expect(test.state.delegations.at(-1)?.phase._tag).toBe("Running");

    child.resolve({ state: "completed", turnId: CHILD_TURN_ID, summary: "Done later." });
    await runtime.drain();
    expect(test.state.delegations.at(-1)).toMatchObject({
      delegationId: handle.delegationId,
      phase: { _tag: "Completed", result: { summary: "Done later." } },
    });
  });

  it("retries failed work as a new record and never changes the original", async () => {
    const original = delegation(DelegationId.make("delegation-original"), {
      anchorMessageId: MessageId.make("message-user"),
      access: access({ memoryScopes: ["project"], allowedToolIds: ["Read"] }),
      phase: {
        _tag: "Failed",
        childThreadId: ThreadId.make("child-old"),
        childTurnId: CHILD_TURN_ID,
        startedAt: NOW,
        completedAt: NOW,
        failure: { failureCode: "child_failed", message: "The child failed." },
        acknowledgedAt: null,
      },
    });

    const test = harness(snapshot({ delegations: [original] }));

    const handle = await test.runtime.dispatchDelegation({
      _tag: "Retry",
      delegationId: original.delegationId,
    });

    await test.runtime.drain();

    expect(test.state.delegations[0]).toEqual(original);
    expect(
      test.commands.filter(
        (command) =>
          (command.type === "delegation.state.set" || command.type === "delegation.create") &&
          command.delegation.delegationId === original.delegationId,
      ),
    ).toEqual([]);

    const retried = test.state.delegations.find(
      (entry) => entry.delegationId === handle.delegationId,
    );

    expect(retried).toMatchObject({
      retryOfDelegationId: original.delegationId,
      anchorMessageId: "message-user",
      trigger: "bot",
      parentBotId: PARENT_BOT_ID,
      childBotId: CHILD_BOT_ID,
      parentTurnId: PARENT_TURN_ID,
      ancestorBotIds: [PARENT_BOT_ID],
      depth: 1,
      task: original.task,
      access: original.access,
      phase: { _tag: "Completed" },
    });

    await expect(
      test.runtime.dispatchDelegation({ _tag: "Retry", delegationId: handle.delegationId }),
    ).rejects.toThrow("Only failed or canceled bot work can be retried.");
    await expect(
      test.runtime.dispatchDelegation({ _tag: "Retry", delegationId: original.delegationId }),
    ).rejects.toThrow("already retried");
  });

  it("fails new bot work whose child turn cannot start, so it stays retryable", async () => {
    const base = harness();

    const test = harness(snapshot(), undefined, {
      dispatch: async (command) => {
        if (command.type === "thread.turn.start") throw new Error("provider unavailable");
        await base.dispatch(command);
      },
      readSnapshot: async () => base.state as never,
    });

    await expect(test.runtime.send(parent(), request() as never)).rejects.toThrow(
      "provider unavailable",
    );
    expect(base.state.delegations.at(-1)?.phase).toMatchObject({
      _tag: "Failed",
      failure: { failureCode: "internal", message: "provider unavailable" },
    });
  });

  it("starts scheduled work from the owner chat that its turn end leaves running", async () => {
    const test = harness(
      snapshot({
        threads: [
          thread(PARENT_THREAD_ID, PARENT_BOT_ID, {
            latestTurn: {
              turnId: PARENT_TURN_ID,
              state: "running",
              requestedAt: NOW,
              startedAt: NOW,
              completedAt: null,
              assistantMessageId: null,
              requestMessageId: MessageId.make("message-user"),
            },
            messages: [
              {
                id: MessageId.make("message-last"),
                role: "assistant",
                text: "Earlier reply.",
                turnId: PARENT_TURN_ID,
                streaming: false,
                createdAt: NOW,
                updatedAt: NOW,
              },
            ],
          }),
        ],
      }),
    );

    const child = Promise.withResolvers<AkeruDelegationChildOutcome>();

    const runtime = createAkeruDelegationRuntime({
      readSnapshot: async () => test.state,
      dispatch: test.dispatch,
      awaitChild: () => child.promise,
      interruptChild: async () => undefined,
      now: () => NOW,
      id: (() => {
        let next = 200;

        return () => String(++next);
      })(),
    });

    await runtime.dispatchDelegation({
      _tag: "Scheduled",
      parentThreadId: PARENT_THREAD_ID,
      parentBotId: PARENT_BOT_ID,
      childBotId: CHILD_BOT_ID,
      task: "Summarize the inbox.",
      expectedResult: "Three bullet points.",
      runtimeMode: "approval-required",
    });
    expect(test.state.delegations.at(-1)).toMatchObject({
      trigger: "scheduled",
      retryOfDelegationId: null,
      anchorMessageId: "message-last",
      parentBotId: PARENT_BOT_ID,
      parentDelegationId: null,
      depth: 1,
      access: { memoryScopes: [], runtimeMode: "approval-required" },
    });
    // The card keeps its own turn, so the running chat turn cannot move it.
    expect(test.state.delegations.at(-1)?.parentTurnId).not.toBe(PARENT_TURN_ID);

    await runtime.parentFinished({
      threadId: PARENT_THREAD_ID,
      turnId: PARENT_TURN_ID,
      failed: true,
    });
    expect(test.state.delegations.at(-1)?.phase._tag).toBe("Running");

    child.resolve({ state: "completed", turnId: CHILD_TURN_ID, summary: "Inbox summary." });
    await runtime.drain();
    expect(test.state.delegations.at(-1)?.phase._tag).toBe("Completed");
  });

  it("deletes the child thread when authoritative delegation admission fails", async () => {
    const commands: OrchestrationCommand[] = [];

    const runtime = createAkeruDelegationRuntime({
      readSnapshot: async () => snapshot(),
      dispatch: async (command) => {
        commands.push(command);

        if (command.type === "delegation.create") throw new Error("Delegation limit reached.");
      },
      awaitChild: async () => ({ state: "completed", turnId: CHILD_TURN_ID, summary: "Done." }),
      interruptChild: async () => undefined,
      now: () => NOW,
      id: () => String(commands.length + 1),
    });

    await expect(runtime.send(parent(), request() as never)).rejects.toThrow(
      "Delegation limit reached.",
    );
    expect(commands.map((command) => command.type)).toEqual([
      "thread.create",
      "delegation.create",
      "thread.delete",
    ]);
  });

  it("grants only the memory scopes the parent holds and the request names", async () => {
    const scoped = harness();
    await scoped.runtime.send(parent(), request({ memoryScopes: ["project"] }) as never);
    expect(scoped.state.delegations.at(-1)?.access.memoryScopes).toEqual(["project"]);

    const omitted = harness();
    await omitted.runtime.send(parent(), request() as never);
    expect(omitted.state.delegations.at(-1)?.access.memoryScopes).toEqual([]);

    await expect(
      harness().runtime.send(parent(), request({ memoryScopes: ["group"] }) as never),
    ).rejects.toThrow("parent turn grant");
  });

  it("preserves blocked state and persists child failure", async () => {
    const blocked = harness(snapshot(), {
      state: "blocked",
      turnId: CHILD_TURN_ID,
      error: "Access denied.",
    });

    await blocked.runtime.send(parent(), request() as never);
    await blocked.runtime.drain();
    expect(blocked.state.delegations.at(-1)).toMatchObject({
      phase: { _tag: "Blocked", reason: "Access denied." },
      billedBotId: CHILD_BOT_ID,
    });

    const failed = harness(snapshot(), {
      state: "failed",
      turnId: CHILD_TURN_ID,
      error: "Provider failed.",
    });

    await failed.runtime.send(parent(), request() as never);
    await failed.runtime.drain();
    expect(failed.state.delegations.at(-1)).toMatchObject({
      phase: { _tag: "Failed", failure: { failureCode: "child_failed" }, acknowledgedAt: null },
      billedBotId: CHILD_BOT_ID,
    });
  });

  it("stores one readable line when the child fails with a stack", async () => {
    const failed = harness(snapshot(), {
      state: "failed",
      turnId: CHILD_TURN_ID,
      error: [
        "ProviderValidationError: Provider instance 'codex' is disabled in Akeru Bot settings.",
        "    at disabledProviderError (file:///srv/akeru/apps/server/src/provider/Layers/AgentController.ts:584:10)",
        "    at ensureSessionForThread (file:///srv/akeru/apps/server/src/orchestration/Layers/ProviderCommandReactor.ts:1282:28)",
      ].join("\n"),
    });

    await failed.runtime.send(parent(), request() as never);
    await failed.runtime.drain();
    const message = "Provider instance 'codex' is disabled in Akeru Bot settings.";
    expect(failed.state.delegations.at(-1)).toMatchObject({
      phase: { _tag: "Failed", failure: { failureCode: "child_failed", message } },
    });

    const delivered = failed.commands.flatMap((command) =>
      command.type === "thread.activity.append" && command.activity.kind === "delegation.failed"
        ? [command.activity.summary]
        : [],
    );

    expect(delivered).toEqual([message]);
  });

  it("runs a second delegation to a busy child bot in its own child chat", async () => {
    const test = harness();
    const children: Array<PromiseWithResolvers<AkeruDelegationChildOutcome>> = [];

    const runtime = createAkeruDelegationRuntime({
      readSnapshot: async () => test.state,
      dispatch: test.dispatch,
      awaitChild: () => {
        const child = Promise.withResolvers<AkeruDelegationChildOutcome>();
        children.push(child);

        return child.promise;
      },
      interruptChild: async () => undefined,
      now: () => NOW,
      id: (() => {
        let value = 0;

        return () => String(++value);
      })(),
    });

    const first = await runtime.send(parent(), request() as never);
    const second = await runtime.send(parent(), request({ task: "A follow-up." }) as never);
    expect(second.delegationId).not.toBe(first.delegationId);
    expect(second.childThreadId).not.toBe(first.childThreadId);
    expect(test.state.delegations.map((entry) => entry.phase._tag)).toEqual(["Running", "Running"]);

    children[1]!.resolve({ state: "completed", turnId: CHILD_TURN_ID, summary: "Second." });
    children[0]!.resolve({ state: "completed", turnId: CHILD_TURN_ID, summary: "First." });
    await runtime.drain();
    expect(
      test.state.delegations.map((entry) =>
        Predicate.isTagged(entry.phase, "Completed") ? entry.phase.result.summary : null,
      ),
    ).toEqual(["First.", "Second."]);
  });

  it("keeps children from an earlier completed turn when a later turn is interrupted", async () => {
    const childThreadId = ThreadId.make("earlier-child");

    const earlier = delegation(DelegationId.make("earlier"), {
      parentTurnId: TurnId.make("turn-earlier"),
      phase: { _tag: "Running", childThreadId, childTurnId: null, startedAt: NOW, progress: null },
    });

    const test = harness(snapshot({ delegations: [earlier] }));

    await test.runtime.parentFinished({
      threadId: PARENT_THREAD_ID,
      turnId: PARENT_TURN_ID,
      failed: false,
    });

    expect(test.state.delegations[0]?.phase._tag).toBe("Running");
    expect(test.commands).toEqual([]);
  });
});
