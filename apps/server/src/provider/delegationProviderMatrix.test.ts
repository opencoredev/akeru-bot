import {
  AkeruDelegationProviderUnsupportedError,
  ProviderInstanceId,
  type OrchestrationCommand,
} from "@akeru/contracts";
import {
  DELEGATION_DRIVER_KINDS,
  driverSupportsDelegation,
} from "@akeru/shared/delegationProviders";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import type { AkeruDelegationChildOutcome } from "./AkeruDelegationRuntime.ts";
import {
  CHILD_BOT_ID,
  CHILD_TURN_ID,
  PARENT_BOT_ID,
  PARENT_THREAD_ID,
  bot,
  harness,
  parent,
  request,
  snapshot,
  thread,
} from "./testUtils/delegationHarness.ts";

// Every provider instance in this matrix is named after its driver kind.
const onDriver = (driverKind: string) => {
  const engine = { provider: ProviderInstanceId.make(driverKind), model: `${driverKind}-model` };
  return harnessFor(
    snapshot({
      bots: [bot(PARENT_BOT_ID, { engine }), bot(CHILD_BOT_ID, { name: "Scout", engine })],
      threads: [
        thread(PARENT_THREAD_ID, PARENT_BOT_ID, {
          modelSelection: { instanceId: engine.provider, model: engine.model },
        }),
      ],
    }),
  );
};

function harnessFor(initial: ReturnType<typeof snapshot>) {
  const child = Promise.withResolvers<AkeruDelegationChildOutcome>();
  const test = harness(initial, undefined, {
    awaitChild: () => child.promise,
    providerDriverKind: async (instanceId) => String(instanceId),
  });
  return { ...test, child };
}

const commandsOf = <Type extends OrchestrationCommand["type"]>(
  commands: readonly OrchestrationCommand[],
  type: Type,
) =>
  commands.filter(
    (command): command is Extract<OrchestrationCommand, { type: Type }> => command.type === type,
  );

describe("delegation provider matrix", () => {
  describe.each(DELEGATION_DRIVER_KINDS)("%s", (driverKind) => {
    it("runs on the controller, so SendToAgent is advertised", () => {
      expect(driverSupportsDelegation(driverKind)).toBe(true);
    });

    it("starts the child, applies the access grant, returns the result, and bills the child", async () => {
      const test = onDriver(driverKind);
      const handle = await test.runtime.send(
        parent(),
        request({ allowedToolIds: ["Read"], memoryScopes: ["project"] }) as never,
      );

      const [create] = commandsOf(test.commands, "thread.create");
      expect(create).toMatchObject({
        threadId: handle.childThreadId,
        botId: CHILD_BOT_ID,
        groupId: null,
        modelSelection: { instanceId: driverKind, model: `${driverKind}-model` },
      });
      expect(commandsOf(test.commands, "thread.turn.start")).toEqual([
        expect.objectContaining({ threadId: handle.childThreadId }),
      ]);
      expect(test.runtime.accessForThread(handle.childThreadId)).toMatchObject({
        allowedToolIds: ["Read"],
        memoryScopes: ["project"],
      });

      test.child.resolve({
        state: "completed",
        turnId: CHILD_TURN_ID,
        summary: "Found it.",
        usage: { inputTokens: 5, outputTokens: 3 },
      });
      await test.runtime.drain();

      expect(test.state.delegations.at(-1)?.phase).toMatchObject({
        _tag: "Completed",
        result: { summary: "Found it.", childTurnId: CHILD_TURN_ID },
      });
      expect(
        commandsOf(test.commands, "thread.activity.append").find(
          (command) => command.activity.kind === "delegation.completed",
        ),
      ).toMatchObject({ threadId: PARENT_THREAD_ID });
      expect(test.usage).toEqual([
        expect.objectContaining({ botId: CHILD_BOT_ID, inputTokens: 5, outputTokens: 3 }),
      ]);
    });

    it("propagates a cancel to the running child's record", async () => {
      const test = onDriver(driverKind);
      const handle = await test.runtime.send(parent(), request() as never);
      await test.runtime.stop(parent(), { botId: CHILD_BOT_ID });
      test.child.resolve({ state: "completed", turnId: CHILD_TURN_ID, summary: "Too late." });
      await test.runtime.drain();

      // The persisted cancel names the child thread, which the provider
      // reactor interrupts; a late child result cannot revive the record.
      expect(commandsOf(test.commands, "delegation.cancel")).toEqual([
        expect.objectContaining({ delegationId: handle.delegationId }),
      ]);
      expect(test.state.delegations.at(-1)?.phase).toMatchObject({
        _tag: "Canceled",
        childThreadId: handle.childThreadId,
      });
    });

    it("enforces the depth cap before creating a child", async () => {
      const test = onDriver(driverKind);
      await expect(test.runtime.send(parent({ depth: 2 }), request() as never)).rejects.toThrow(
        "depth",
      );
      expect(test.commands).toEqual([]);
    });
  });

  describe("opencode (legacy bridge)", () => {
    it("does not run on the controller, so SendToAgent is not advertised", () => {
      expect(driverSupportsDelegation("opencode")).toBe(false);
    });

    it("refuses handed-off work with a readable reason before creating a child", async () => {
      const test = onDriver("opencode");
      const refused = await test.runtime
        .send(parent(), request() as never)
        .catch((cause: unknown) => cause);

      expect(Schema.is(AkeruDelegationProviderUnsupportedError)(refused)).toBe(true);
      expect((refused as Error).message).toBe(
        "Scout runs on the opencode provider, which cannot receive handed-off work. Do the work yourself or pick a bot on another provider.",
      );
      expect(test.commands).toEqual([]);
    });
  });
});
