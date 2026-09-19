import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { RuntimeMemoryRepositoriesLive } from "../server.ts";
import { EntityMemoryRepository } from "./Services/EntityMemoryRepository.ts";

const layer = RuntimeMemoryRepositoriesLive.pipe(Layer.provideMerge(SqlitePersistenceMemory));

it.layer(layer)("legacy memory migration repository", (it) => {
  it.effect("provides the read adapter used by the one-time migration", () =>
    Effect.gen(function* () {
      assert.isDefined(yield* EntityMemoryRepository);
    }),
  );
});
