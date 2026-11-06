import {
  BotId,
  EnvironmentId,
  type EnvironmentHostDescriptor,
  ProviderDriverKind,
} from "@akeru/contracts";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { assert, describe, expect } from "vite-plus/test";

import { EnvironmentHost } from "../../environment/EnvironmentHost.ts";
import * as ProjectionSnapshotQuery from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { AgentController } from "../Services/AgentController.ts";
import {
  codexInstanceId,
  codexSelection,
  codexThreadId,
} from "./test-support/agentControllerFixtures.ts";
import { mastraHarnessFixture } from "./test-support/agentControllerHarness.ts";
import {
  makeBridge,
  provideController,
  resolveCodex,
} from "./test-support/agentControllerLayers.ts";
import {
  projectionQueryFixture,
  providerBotFixture,
  providerRuntimeContext,
} from "./test-support/projectionFixtures.ts";

const HOME = EnvironmentId.make("env-home");

const firstBotId = BotId.make("bot-first");

const secondBotId = BotId.make("bot-second");

const firstBotEnvironment = EnvironmentId.make("env-first-only");

const secondBotEnvironment = EnvironmentId.make("env-second-only");

const local: EnvironmentHostDescriptor = {
  environmentId: HOME,
  label: "Home",
  platform: { os: "linux", arch: "x64" },
  cpuCount: 4,
  load: null,
  tools: [],
  providers: [],
  projects: [],
  profile: { labels: [], note: "", placementWeight: "normal" },
};

const bots = new Map([
  [
    firstBotId,
    providerBotFixture({ id: firstBotId, allowedEnvironmentIds: [firstBotEnvironment] }),
  ],
  [
    secondBotId,
    providerBotFixture({ id: secondBotId, allowedEnvironmentIds: [secondBotEnvironment] }),
  ],
]);

describe("AgentController list_environments", () => {
  it.effect("lists the answering bot's environments when a shared session is reused", () => {
    const bridge = makeBridge();
    const mastra = mastraHarnessFixture();

    return provideController(
      Effect.gen(function* () {
        const controller = yield* AgentController;
        yield* resolveCodex(controller);

        const sessionInput = {
          threadId: codexThreadId,
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: codexInstanceId,
          cwd: process.cwd(),
          modelSelection: codexSelection,
          botSandboxBrowserSharing: "shared" as const,
          runtimeMode: "full-access" as const,
        };

        const listEnvironments = Effect.fn(function* (toolCallId: string) {
          const runtime = mastra.harnessOptions[0]?.toolRuntime;
          assert.isDefined(runtime);

          const result = yield* Effect.promise(() =>
            runtime.execute({
              threadId: String(codexThreadId),
              toolId: "list_environments",
              toolCallId,
              input: {},
              approvalMode: "require-grant",
            }),
          );

          return result;
        });

        yield* controller.startSession(codexThreadId, {
          ...sessionInput,
          botId: firstBotId,
          botName: "First",
        });

        expect(yield* listEnvironments("first")).toMatchObject({
          excluded: [{ environmentId: firstBotEnvironment }],
        });

        yield* controller.startSession(codexThreadId, {
          ...sessionInput,
          botId: secondBotId,
          botName: "Second",
        });

        expect(mastra.createSession).toHaveBeenCalledOnce();
        expect(yield* listEnvironments("second")).toMatchObject({
          excluded: [{ environmentId: secondBotEnvironment }],
        });
      }),
      bridge.service,
      mastra.factory,
    ).pipe(
      Effect.provideService(
        EnvironmentHost,
        EnvironmentHost.of({ describe: Effect.succeed(local) }),
      ),
      Effect.provideService(
        ProjectionSnapshotQuery.ProjectionSnapshotQuery,
        ProjectionSnapshotQuery.ProjectionSnapshotQuery.of(
          projectionQueryFixture({
            getThreadRuntimeContext: (threadId) =>
              Effect.succeed(Option.some(providerRuntimeContext({ id: threadId, botId: null }))),
            getBotById: (botId) => Effect.succeed(Option.fromNullishOr(bots.get(botId))),
            getGroupById: () => Effect.succeed(Option.none()),
            listThreadDelegations: () => Effect.succeed([]),
          }),
        ),
      ),
    );
  });
});
