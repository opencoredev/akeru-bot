import { describe } from "vite-plus/test";
// @effect-diagnostics nodeBuiltinImport:off
import {
  AKERU_DELEGATION_CONTEXT_MAX_CHARS,
  AkeruDelegationContextTooLongError,
  DelegationId,
  ProviderInstanceId,
} from "@akeru/contracts";
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
  OTHER_BOT_ID,
  PARENT_BOT_ID,
  PARENT_THREAD_ID,
  PARENT_TURN_ID,
  access,
  bot,
  delegation,
  harness,
  parent,
  request,
  snapshot,
  thread,
} from "./testUtils/delegationHarness.ts";

describe("delegation access", () => {
  it("rejects extra memory, tools, full access, and approval upgrades", () => {
    for (const requested of [
      { memoryScopes: ["workspace"] },
      { allowedToolIds: ["ExternalShell"] },
      { runtimeMode: "full-access" },
      { approvalCeiling: "production" },
    ]) {
      expect(() =>
        intersectDelegationAccess({
          parent: access(),
          child: access({ runtimeMode: "full-access", approvalCeiling: "secrets" }),
          requested: request(requested) as never,
        }),
      ).toThrow("parent turn grant");
    }
  });

  it("allows a delegation to remove sandbox access", () => {
    expect(
      intersectDelegationAccess({
        parent: access({ sandbox: "local" }),
        child: access({ sandbox: "local" }),
        requested: request({ sandbox: null }) as never,
      }).sandbox,
    ).toBeNull();
  });
});

describe("AkeruDelegationRuntime", () => {
  it("rejects user messages from a bot that does not own the active thread", async () => {
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
      test.runtime.sendToUser(parent({ botId: OTHER_BOT_ID }), { message: "Wrong thread." }),
    ).rejects.toThrow("not authorized");
  });

  it("rejects A to B to A cycles, depth, and concurrency caps", async () => {
    await expect(
      harness().runtime.send(
        parent({ botId: CHILD_BOT_ID, ancestorBotIds: [PARENT_BOT_ID] }),
        request({ botId: PARENT_BOT_ID }) as never,
      ),
    ).rejects.toThrow("cycle");
    await expect(harness().runtime.send(parent({ depth: 2 }), request() as never)).rejects.toThrow(
      "depth",
    );
    const active = [1, 2, 3].map((index) => delegation(DelegationId.make(`active-${index}`)));
    await expect(
      harness(snapshot({ delegations: active })).runtime.send(parent(), request() as never),
    ).rejects.toThrow("more than 3");
  });

  it("hands bounded parent context to the child and rejects oversized context", async () => {
    const test = harness();
    await test.runtime.send(
      parent(),
      request({ context: "The user prefers metric units." }) as never,
    );
    const start = test.commands.find((command) => command.type === "thread.turn.start");
    expect(start && "message" in start ? start.message.text : null).toContain(
      "Context from the parent bot:\nThe user prefers metric units.",
    );

    const oversized = "x".repeat(AKERU_DELEGATION_CONTEXT_MAX_CHARS + 1);
    const rejected = harness();
    await expect(
      rejected.runtime.send(parent(), request({ context: oversized }) as never),
    ).rejects.toBeInstanceOf(AkeruDelegationContextTooLongError);
    expect(rejected.commands).toEqual([]);
  });

  it("still fails remaining children when one settlement write is rejected", async () => {
    let nextId = 0;
    const test = harness();
    const children: Array<PromiseWithResolvers<AkeruDelegationChildOutcome>> = [];
    const watchErrors: unknown[] = [];
    let rejectNextStateSet = false;

    const runtime = createAkeruDelegationRuntime({
      readSnapshot: async () => test.state,
      dispatch: async (command) => {
        if (rejectNextStateSet && command.type === "delegation.state.set") {
          rejectNextStateSet = false;
          throw new Error("state.set rejected");
        }

        await test.dispatch(command);
      },
      awaitChild: () => {
        const child = Promise.withResolvers<AkeruDelegationChildOutcome>();
        children.push(child);

        return child.promise;
      },
      interruptChild: async (threadId, turnId) => {
        test.interrupts.push({ threadId, turnId });
      },
      onWatchError: (_, cause) => watchErrors.push(cause),
      now: () => NOW,
      id: () => String(++nextId),
    });

    await runtime.send(parent(), request() as never);
    await runtime.send(parent(), request({ task: "Second task." }) as never);
    expect(test.state.delegations.map((entry) => entry.phase._tag)).toEqual(["Running", "Running"]);

    // The first child's Failed write is rejected; the rejection must surface
    // through onWatchError without stopping the second child's settlement.
    rejectNextStateSet = true;
    await runtime.parentFinished({
      threadId: PARENT_THREAD_ID,
      turnId: PARENT_TURN_ID,
      failed: true,
    });
    children[0]!.resolve({ state: "failed", turnId: CHILD_TURN_ID, error: "Interrupted." });
    children[1]!.resolve({ state: "failed", turnId: CHILD_TURN_ID, error: "Interrupted." });
    await runtime.drain();

    expect(test.state.delegations[0]?.phase._tag).toBe("Running");
    expect(test.state.delegations[1]?.phase).toMatchObject({
      _tag: "Failed",
      failure: { failureCode: "parent_failed" },
    });
    // Both children stop, including the one whose Failed write was rejected.
    expect(test.interrupts).toHaveLength(2);
    expect(watchErrors).toHaveLength(1);
    expect(watchErrors[0]).toBeInstanceOf(Error);
    expect((watchErrors[0] as Error).message).toBe("state.set rejected");
  });

  it("refuses a target whose provider instance is unknown before creating the child chat", async () => {
    const test = harness(
      snapshot({
        bots: [
          bot(PARENT_BOT_ID),
          bot(CHILD_BOT_ID, {
            engine: { provider: ProviderInstanceId.make("deleted-instance"), model: "model" },
          }),
        ],
      }),
      undefined,
      { providerDriverKind: async () => null },
    );

    await expect(test.runtime.send(parent(), request() as never)).rejects.toThrow(
      "The target bot is not available in this workspace.",
    );
    expect(test.commands).toEqual([]);
  });
});
