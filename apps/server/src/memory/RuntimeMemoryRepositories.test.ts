import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { RuntimeMemoryRepositoriesLive } from "../server.ts";
import { EntityMemoryRepository } from "./Services/EntityMemoryRepository.ts";
import { MemoryCandidateRepository } from "./Services/MemoryCandidateRepository.ts";

const layer = RuntimeMemoryRepositoriesLive.pipe(Layer.provideMerge(SqlitePersistenceMemory));

it.layer(layer)("runtime memory repositories", (it) => {
  it.effect("provides both live repositories", () =>
    Effect.gen(function* () {
      assert.isDefined(yield* EntityMemoryRepository);
      assert.isDefined(yield* MemoryCandidateRepository);
    }),
  );
});
