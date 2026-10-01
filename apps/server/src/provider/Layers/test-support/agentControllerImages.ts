// @effect-diagnostics globalDate:off globalFetch:off globalFetchInEffect:off nodeBuiltinImport:off preferSchemaOverJson:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import { BotId, TurnId, type OrchestrationCommand } from "@akeru/contracts";
import type { AkeruUsageEntry } from "@akeru/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ServerConfig } from "../../../config.ts";
import { layerTest as serverSettingsLayerTest } from "../../../serverSettings.ts";
import {
  layerWith as imageGenerationRuntimeLayerWith,
  type ImageSubscriptionAuth,
} from "../../../image-generation/ImageGenerationRuntime.ts";
import { type ImageProviderAdapter } from "../../../image-generation/adapters.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProjectionBotRepository } from "../../../persistence/Services/ProjectionBots.ts";
import { ProjectionThreadMessageRepository } from "../../../persistence/Services/ProjectionThreadMessages.ts";
import * as OrchestrationEngine from "../../../orchestration/Services/OrchestrationEngine.ts";
import { BotUsageLedger } from "../../../usage/BotUsageLedger.ts";
// oxlint-disable-next-line anti-slop-effect/no-service-constructor-imports -- Test composition root builds the configured UsageLedger double or Layer for isolated provider tests.
import { makeUsageLedger } from "./agentControllerMemory.ts";

export function makeImageRuntimeTestLayer(input: {
  readonly baseDir: string;
  readonly adapters: Readonly<Record<"chatgpt" | "grok", ImageProviderAdapter>>;
  readonly connected: ReadonlyArray<"openai-codex" | "xai">;
  readonly settings: { readonly chatgptEnabled?: boolean; readonly grokEnabled?: boolean };
  readonly botProvider: "chatgpt" | "grok" | null;
  readonly requestTimeout?: Duration.Input;
}) {
  const dispatched: OrchestrationCommand[] = [];
  const imageUsage: Array<unknown> = [];

  const subscriptionAuth: ImageSubscriptionAuth = {
    statuses: () =>
      input.connected.map((provider) => ({
        provider,
        connected: true,
        health: "healthy" as const,
        reconnectAction: "",
        healthTest: { status: "not-run" as const },
        dependentBots: [],
        dependentRoutines: [],
      })),
    recordImageGenerationSuccess: () => undefined,
    recordImageRequestFailure: () => undefined,
  };

  const layer = imageGenerationRuntimeLayerWith({
    adapters: input.adapters,
    subscriptionAuth,
    ...(input.requestTimeout ? { requestTimeout: input.requestTimeout } : {}),
  }).pipe(
    Layer.provideMerge(
      Layer.succeed(
        OrchestrationEngine.OrchestrationEngineService,
        OrchestrationEngine.OrchestrationEngineService.of({
          readEvents: () => Stream.empty,
          readThreadEvents: () => Stream.empty,
          getThreadReplayStats: () => Effect.die("unused"),
          subscribeDomainEvents: Effect.succeed(Stream.empty),
          latestSequence: Effect.succeed(0),
          dispatch: (command) =>
            Effect.sync(() => {
              dispatched.push(command);

              return { sequence: dispatched.length };
            }),
          streamDomainEvents: Stream.empty,
        }),
      ),
    ),
    Layer.provideMerge(
      Layer.succeed(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
        getThreadShellById: () =>
          Effect.succeed(
            Option.some({
              latestTurn: {
                state: "running",
                turnId: TurnId.make("turn-image"),
                respondingBotId: BotId.make("bot-image"),
                requestedAt: "2026-01-01T00:00:00.000Z",
                startedAt: null,
                completedAt: null,
                assistantMessageId: null,
              },
              respondingBotId: BotId.make("bot-image"),
              botId: BotId.make("bot-image"),
            }),
          ),
      } as never),
    ),
    Layer.provideMerge(
      Layer.succeed(ProjectionBotRepository, {
        getById: () =>
          Effect.succeed(
            Option.some({ id: BotId.make("bot-image"), imageProvider: input.botProvider }),
          ),
      } as never),
    ),
    Layer.provideMerge(
      Layer.succeed(ProjectionThreadMessageRepository, {
        listByThreadId: () => Effect.succeed([]),
      } as never),
    ),
    Layer.provideMerge(serverSettingsLayerTest({ imageGeneration: input.settings })),
    Layer.provideMerge(
      Layer.succeed(
        BotUsageLedger,
        BotUsageLedger.of({
          ...makeUsageLedger().service,
          recordMeasurement: (measurement) =>
            Effect.sync(() => {
              imageUsage.push(measurement);

              return {
                ...measurement,
                state: "reported",
                reservedTokens: 0,
                unavailableReason: null,
                settledAt: measurement.createdAt,
              } as AkeruUsageEntry;
            }),
        }),
      ),
    ),
    Layer.provideMerge(Layer.succeed(SqlClient.SqlClient, {} as never)),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), input.baseDir)),
    Layer.provideMerge(NodeServices.layer),
  );

  return { layer, dispatched, imageUsage };
}
