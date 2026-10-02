import { CommandId, ProjectId, ProviderInstanceId } from "@akeru/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import { describe, expect } from "vite-plus/test";
import { PersistenceSqlError } from "../../persistence/Errors.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { OrchestrationProjectionPipeline } from "../Services/ProjectionPipeline.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../ThreadPlanProgress.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";

const rejection = new PersistenceSqlError({ operation: "test projection", detail: "rejected" });

const defect = new Error("projection defect");

const cases = [
  { name: "typed rejection", failure: Effect.fail(rejection), expected: Cause.fail(rejection) },
  { name: "defect", failure: Effect.die(defect), expected: Cause.die(defect) },
  { name: "interruption", failure: Effect.interrupt, expected: Cause.interrupt() },
];

describe("OrchestrationEngine dispatch failures", () => {
  for (const { name, failure, expected } of cases) {
    it.effect(`preserves ${name} causes and keeps processing commands`, () => {
      const pipeline = OrchestrationProjectionPipeline.of({
        bootstrap: Effect.void,
        projectEvent: () => Effect.void,
        projectEventDeferred: (event) =>
          event.commandId === CommandId.make("cmd-failure") ? failure : Effect.succeed(Effect.void),
      });

      const engineLayer = OrchestrationEngineLive.pipe(
        Layer.provide(OrchestrationProjectionSnapshotQueryLive),
        Layer.provide(ThreadBackgroundLiveness.layer),
        Layer.provide(ThreadPlanProgress.layer),
        Layer.provide(Layer.succeed(OrchestrationProjectionPipeline, pipeline)),
        Layer.provide(OrchestrationEventStoreLive),
        Layer.provide(OrchestrationCommandReceiptRepositoryLive),
        Layer.provide(RepositoryIdentityResolver.layer),
        Layer.provide(SqlitePersistenceMemory),
        Layer.provide(NodeServices.layer),
      );

      return Effect.gen(function* () {
        const engine = yield* OrchestrationEngineService;

        const command = {
          type: "project.create",
          commandId: CommandId.make("cmd-failure"),
          projectId: ProjectId.make("project-failure"),
          title: "Project",
          workspaceRoot: "/tmp/project-failure",
          defaultModelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          createdAt: "2026-01-01T00:00:00.000Z",
        } as const;

        const exit = yield* Effect.exit(engine.dispatch(command));
        expect(Exit.isFailure(exit)).toBe(true);

        if (Exit.isFailure(exit)) {
          expect(Cause.hasFails(exit.cause)).toBe(Cause.hasFails(expected));
          expect(Cause.hasDies(exit.cause)).toBe(Cause.hasDies(expected));
          expect(Cause.hasInterruptsOnly(exit.cause)).toBe(Cause.hasInterruptsOnly(expected));

          if (!Cause.hasInterruptsOnly(expected)) {
            expect(Cause.squash(exit.cause)).toBe(Cause.squash(expected));
          }
        }

        const acknowledgement = yield* engine.dispatch({
          ...command,
          commandId: CommandId.make("cmd-recovery"),
        });

        expect(acknowledgement.sequence).toBeGreaterThan(0);
      }).pipe(Effect.provide(engineLayer));
    });
  }
});
