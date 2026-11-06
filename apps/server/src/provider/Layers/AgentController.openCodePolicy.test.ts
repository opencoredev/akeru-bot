import {
  BotId,
  DEFAULT_BOT_PERMISSION_POLICY,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type BotPermissionPolicy,
} from "@akeru/contracts";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { describe, expect } from "vite-plus/test";

import * as ProjectionSnapshotQuery from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { AgentController } from "../Services/AgentController.ts";
import { makeBridge, provideController } from "./test-support/agentControllerLayers.ts";
import { mastraHarnessFixture } from "./test-support/agentControllerHarness.ts";
import {
  projectionQueryFixture,
  providerBotFixture,
  providerRuntimeContext,
} from "./test-support/projectionFixtures.ts";

const botId = BotId.make("bot-opencode");

const threadId = ThreadId.make("thread-native-opencode");

const instanceId = ProviderInstanceId.make("opencode");

const selection = { instanceId, model: "fixture-model" };

const denyOutside: BotPermissionPolicy = {
  ...DEFAULT_BOT_PERMISSION_POLICY,
  defaults: { ...DEFAULT_BOT_PERMISSION_POLICY.defaults, "write-outside": "deny" },
};

/** Runs `body` against a native OpenCode bot whose stored policy the test can change. */
const withOpenCodeBot = <A, E>(
  initial: BotPermissionPolicy,
  body: (input: {
    readonly controller: AgentController["Service"];
    readonly bridge: ReturnType<typeof makeBridge>;
    readonly setPolicy: (policy: BotPermissionPolicy) => void;
  }) => Effect.Effect<A, E, AgentController>,
) => {
  const bridge = makeBridge();
  const mastra = mastraHarnessFixture();
  let policy = initial;

  return provideController(
    Effect.gen(function* () {
      const controller = yield* AgentController;
      yield* controller.resolveEngine({
        threadId,
        engine: null,
        fallback: selection,
        mode: "default",
        botConversation: true,
      });

      return yield* body({
        controller,
        bridge,
        setPolicy: (next) => {
          policy = next;
        },
      });
    }),
    bridge.service,
    mastra.factory,
  ).pipe(
    Effect.provideService(
      ProjectionSnapshotQuery.ProjectionSnapshotQuery,
      ProjectionSnapshotQuery.ProjectionSnapshotQuery.of(
        projectionQueryFixture({
          getThreadRuntimeContext: (id: ThreadId) =>
            Effect.succeed(Option.some(providerRuntimeContext({ id, botId }))),
          getBotById: () =>
            Effect.sync(() =>
              Option.some(providerBotFixture({ id: botId, permissionPolicy: policy })),
            ),
          getGroupById: () => Effect.succeed(Option.none()),
          listThreadDelegations: () => Effect.succeed([]),
        }),
      ),
    ),
  );
};

const start = (controller: AgentController["Service"]) =>
  controller.startSession(threadId, {
    threadId,
    provider: ProviderDriverKind.make("opencode"),
    providerInstanceId: instanceId,
    modelSelection: selection,
    runtimeMode: "full-access",
    botId,
  });

describe("AgentControllerLive native OpenCode permission policy", () => {
  it.effect("refuses to start a full-access OpenCode bot whose policy denies outside writes", () =>
    withOpenCodeBot(denyOutside, ({ controller, bridge }) =>
      Effect.gen(function* () {
        const failure = yield* start(controller).pipe(Effect.flip);

        expect(failure.message).toContain("can't be enforced on OpenCode");
        expect(failure.message).toContain("write-outside: deny");
        expect(bridge.startSession).not.toHaveBeenCalled();
      }),
    ),
  );

  it.effect("refuses the next turn when the owner tightens the policy after start", () =>
    withOpenCodeBot(DEFAULT_BOT_PERMISSION_POLICY, ({ controller, bridge, setPolicy }) =>
      Effect.gen(function* () {
        yield* start(controller);
        expect(bridge.startSession).toHaveBeenCalledOnce();

        setPolicy({ ...DEFAULT_BOT_PERMISSION_POLICY, toolOverrides: { Shell: "deny" } });

        const failure = yield* controller
          .sendTurn({ threadId, input: "Push the branch." })
          .pipe(Effect.flip);

        expect(failure.message).toContain("Shell: deny");
        expect(bridge.sendTurn).not.toHaveBeenCalled();
      }),
    ),
  );

  it.effect("starts and runs a turn under the default policy", () =>
    withOpenCodeBot(DEFAULT_BOT_PERMISSION_POLICY, ({ controller, bridge }) =>
      Effect.gen(function* () {
        yield* start(controller);
        yield* controller.sendTurn({ threadId, input: "Say hi." });

        expect(bridge.sendTurn).toHaveBeenCalledOnce();
      }),
    ),
  );
});
