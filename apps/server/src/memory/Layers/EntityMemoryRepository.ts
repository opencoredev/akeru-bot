import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  EntityMemoryRepository,
  type EntityMemoryRepositoryShape,
} from "../Services/EntityMemoryRepository.ts";
import { makeEntityMemoryStorage } from "./EntityMemoryStorage.ts";
import { makeEntityMemoryQueries } from "./EntityMemoryQueries.ts";
import { makeEntityMemoryImport } from "./EntityMemoryImport.ts";
import { makeEntityMemoryWrites } from "./EntityMemoryWrites.ts";

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
  } = yield* makeEntityMemoryStorage();

  const { search, listCurrent, isRevisionAuthorized, listHistory, listByPartitions } =
    yield* makeEntityMemoryQueries({ sql, getCurrent });

  const { previewImport, applyImport } = yield* makeEntityMemoryImport({
    sql,
    writeLock,
    insertRow,
    expectedEntity,
    invalidateDerivedCopies,
    isRevisionAuthorized,
  });

  const { insert, revise, tombstone, deleteRoot, insertScopedFact, applyMutation } =
    yield* makeEntityMemoryWrites({
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
