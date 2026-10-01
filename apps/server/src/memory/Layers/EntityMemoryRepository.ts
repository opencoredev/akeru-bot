import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  EntityMemoryRepository,
  type EntityMemoryRepositoryShape,
} from "../Services/EntityMemoryRepository.ts";
import { entityMemoryStorage } from "./EntityMemoryStorage.ts";
import { entityMemoryQueries } from "./EntityMemoryQueries.ts";
import { entityMemoryImport } from "./EntityMemoryImport.ts";
import { entityMemoryWrites } from "./EntityMemoryWrites.ts";

const makeEntityMemoryRepository = Effect.gen(function* () {
  const {
    sql,
    writeLock,
    insertRow,
    samePartition,
    expectedEntity,
    authorizeRevision,
    getCurrent,
    invalidateDerivedCopies,
    invalidateObservations,
    recordDerivedCopies,
  } = yield* entityMemoryStorage();

  const { search, listCurrent, isRevisionAuthorized, listHistory, listByPartitions } =
    yield* entityMemoryQueries({ sql, getCurrent });

  const { previewImport, applyImport } = yield* entityMemoryImport({
    sql,
    writeLock,
    insertRow,
    expectedEntity,
    invalidateDerivedCopies,
    isRevisionAuthorized,
  });

  const { insert, revise, tombstone, deleteRoot, insertScopedFact, applyMutation } =
    yield* entityMemoryWrites({
      sql,
      writeLock,
      insertRow,
      samePartition,
      expectedEntity,
      authorizeRevision,
      getCurrent,
      invalidateDerivedCopies,
      invalidateObservations,
      isRevisionAuthorized,
    });

  return {
    recordDerivedCopies,
    insert,
    revise,
    tombstone,
    getCurrent,
    search,
    listCurrent,
    listHistory,
    listByPartitions,
    previewImport,
    applyImport,
    deleteRoot,
    insertScopedFact,
    applyMutation,
  } satisfies EntityMemoryRepositoryShape;
});

export const EntityMemoryRepositoryLive = Layer.effect(
  EntityMemoryRepository,
  makeEntityMemoryRepository,
);
