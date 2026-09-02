import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ChannelDeliveryStore from "../channels/ChannelDeliveryStore.ts";
import * as ServerConfig from "../config.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { OrchestrationInfrastructureLayerLive } from "./runtimeLayer.ts";

it.effect("provides channel delivery storage to the server runtime", () =>
  Effect.gen(function* () {
    const store = yield* Effect.serviceOption(ChannelDeliveryStore.ChannelDeliveryStore);

    assert.isTrue(Option.isSome(store));
  }).pipe(
    Effect.provide(
      OrchestrationInfrastructureLayerLive.pipe(
        Layer.provideMerge(RepositoryIdentityResolver.layer),
        Layer.provideMerge(SqlitePersistenceMemory),
        Layer.provideMerge(
          ServerConfig.layerTest(process.cwd(), { prefix: "runtime-layer-test-" }),
        ),
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  ),
);
