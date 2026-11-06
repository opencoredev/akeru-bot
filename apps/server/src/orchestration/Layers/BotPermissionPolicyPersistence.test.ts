import {
  BotId,
  BotPermissionPersonId,
  CommandId,
  DEFAULT_BOT_PERMISSION_POLICY,
  type BotPermissionPolicy,
} from "@akeru/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { TestLayer } from "./test-support/BotPersistenceHarness.ts";

const policy: BotPermissionPolicy = {
  ...DEFAULT_BOT_PERMISSION_POLICY,
  toolOverrides: { SendToUser: "allow", ExternalShell: "deny" },
  people: [
    {
      personId: BotPermissionPersonId.make("alice"),
      riskClasses: {
        read: "allow",
        "write-workspace": "ask",
        "write-outside": "deny",
        "environment-access": "deny",
      },
    },
  ],
};

it.layer(TestLayer)("bot permission policy persistence", (it) => {
  it.effect("stores, reads back, and clears a bot's permission policy", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const snapshots = yield* ProjectionSnapshotQuery;
      const botId = BotId.make("bot-policy");

      const readAll = Effect.gen(function* () {
        const shell = (yield* snapshots.getShellSnapshot()).bots.find((bot) => bot.id === botId);
        const model = (yield* snapshots.getCommandReadModel()).bots.find((bot) => bot.id === botId);

        const byId = snapshots.getBotById
          ? Option.getOrUndefined(yield* snapshots.getBotById(botId))
          : undefined;

        return [shell?.permissionPolicy, model?.permissionPolicy, byId?.permissionPolicy];
      });

      yield* engine.dispatch({
        type: "bot.create",
        commandId: CommandId.make("cmd-policy-create"),
        botId,
        name: "Guard",
        title: "Assistant",
        avatar: { kind: "dither", seed: "guard" },
        engine: null,
        sandbox: "local",
        groupId: null,
        createdAt: "2026-10-30T00:00:00.000Z",
      });
      // A bot without a stored policy uses the default.
      assert.deepEqual(yield* readAll, [undefined, undefined, undefined]);

      yield* engine.dispatch({
        type: "bot.update",
        commandId: CommandId.make("cmd-policy-set"),
        botId,
        permissionPolicy: policy,
      });
      assert.deepEqual(yield* readAll, [policy, policy, policy]);

      yield* engine.dispatch({
        type: "bot.update",
        commandId: CommandId.make("cmd-policy-rename"),
        botId,
        name: "Guardian",
      });
      assert.deepEqual(yield* readAll, [policy, policy, policy]);

      yield* engine.dispatch({
        type: "bot.update",
        commandId: CommandId.make("cmd-policy-clear"),
        botId,
        permissionPolicy: null,
      });
      assert.deepEqual(yield* readAll, [undefined, undefined, undefined]);
    }),
  );
});
