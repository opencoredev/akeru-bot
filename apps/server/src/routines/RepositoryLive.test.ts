// @effect-diagnostics globalDate:off globalDateInEffect:off
import { assert, it } from "@effect/vitest";
import { RoutineRunId, ThreadId } from "@akeru/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { RoutineRepository } from "./Repository.ts";
import { RoutineRepositoryLive } from "./RepositoryLive.ts";

const layer = RoutineRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory));

it.layer(layer)("RoutineRepository.listThreadRuns", (it) => {
  it.effect("bounds each page and reaches older runs from deleted routines", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const repository = yield* RoutineRepository;
      const threadId = ThreadId.make("paged-routine-thread");
      const otherThreadId = ThreadId.make("other-routine-thread");
      for (const [routineId, targetThreadId, lifecycle] of [
        ["paged-routine", threadId, "deleted"],
        ["other-routine", otherThreadId, "enabled"],
      ] as const) {
        yield* sql`
          INSERT INTO projection_routines (
            routine_id, bot_id, target_thread_id, project_id, job, procedure,
            procedure_version, schedule_json, timezone, sandbox, approval_policy,
            lifecycle, created_at, updated_at
          ) VALUES (
            ${routineId}, 'bot-1', ${targetThreadId}, 'project-1', 'Daily note', 'Write a note',
            1, '{"kind":"daily","time":"09:00"}', 'UTC', 'local', 'approval-required',
            ${lifecycle}, '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z'
          )
        `;
      }
      for (let index = 0; index < 151; index++) {
        const runId = `paged-run-${String(index).padStart(3, "0")}`;
        const createdAt = new Date(Date.UTC(2026, 8, 1, 0, index)).toISOString();
        yield* sql`
          INSERT INTO projection_routine_runs (
            run_id, routine_id, procedure_version, trigger, status, created_at, updated_at
          ) VALUES (${runId}, 'paged-routine', 1, 'manual', 'completed', ${createdAt}, ${createdAt})
        `;
      }
      yield* sql`
        INSERT INTO projection_routine_runs (
          run_id, routine_id, procedure_version, trigger, status, created_at, updated_at
        ) VALUES (
          'other-run', 'other-routine', 1, 'manual', 'completed',
          '2026-09-30T00:00:00.000Z', '2026-09-30T00:00:00.000Z'
        )
      `;

      const first = yield* repository.listThreadRuns(threadId);
      assert.equal(first.runs.length, 100);
      assert.equal(first.runs[0]?.id, RoutineRunId.make("paged-run-150"));
      assert.equal(first.nextCursor, RoutineRunId.make("paged-run-051"));
      const second = yield* repository.listThreadRuns(threadId, first.nextCursor!);
      assert.equal(second.runs.length, 51);
      assert.equal(second.runs.at(-1)?.id, RoutineRunId.make("paged-run-000"));
      assert.equal(second.nextCursor, null);
      assert.equal(new Set([...first.runs, ...second.runs].map((run) => run.id)).size, 151);
    }),
  );
});
