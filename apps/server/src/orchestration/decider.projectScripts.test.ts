import { CommandId } from "@akeru/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";
import { asProjectId, asEventId } from "./test-support/ProjectDeciderFixtures.ts";

it.layer(NodeServices.layer)("decider project scripts", (it) => {
  it.effect("emits empty scripts on project.create", () =>
    Effect.gen(function* () {
      const now = "2026-01-01T00:00:00.000Z";
      const readModel = createEmptyReadModel(now);

      const result = yield* decideOrchestrationCommand({
        command: {
          type: "project.create",
          commandId: CommandId.make("cmd-project-create-scripts"),
          projectId: asProjectId("project-scripts"),
          title: "Scripts",
          workspaceRoot: "/tmp/scripts",
          createdAt: now,
        },
        readModel,
      });

      const event = Array.isArray(result) ? result[0] : result;
      expect(event.type).toBe("project.created");
      expect((event.payload as { scripts: unknown[] }).scripts).toEqual([]);
    }),
  );

  it.effect("propagates scripts in project.meta.update payload", () =>
    Effect.gen(function* () {
      const now = "2026-01-01T00:00:00.000Z";
      const initial = createEmptyReadModel(now);
      const readModel = yield* projectEvent(initial, {
        sequence: 1,
        eventId: asEventId("evt-project-create-scripts"),
        aggregateKind: "project",
        aggregateId: asProjectId("project-scripts"),
        type: "project.created",
        occurredAt: now,
        commandId: CommandId.make("cmd-project-create-scripts"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-project-create-scripts"),
        metadata: {},
        payload: {
          projectId: asProjectId("project-scripts"),
          title: "Scripts",
          workspaceRoot: "/tmp/scripts",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });

      const scripts = [
        {
          id: "lint",
          name: "Lint",
          command: "bun run lint",
          icon: "lint",
          runOnWorktreeCreate: false,
        },
      ] as const;

      const result = yield* decideOrchestrationCommand({
        command: {
          type: "project.meta.update",
          commandId: CommandId.make("cmd-project-update-scripts"),
          projectId: asProjectId("project-scripts"),
          scripts: Array.from(scripts),
        },
        readModel,
      });

      const event = Array.isArray(result) ? result[0] : result;
      expect(event.type).toBe("project.meta-updated");
      expect((event.payload as { scripts?: unknown[] }).scripts).toEqual(scripts);
    }),
  );

  it.effect("propagates a project favicon path in project.meta.update", () =>
    Effect.gen(function* () {
      const now = "2026-01-01T00:00:00.000Z";
      const readModel = yield* projectEvent(createEmptyReadModel(now), {
        sequence: 1,
        eventId: asEventId("evt-project-create-favicon"),
        aggregateKind: "project",
        aggregateId: asProjectId("project-favicon"),
        type: "project.created",
        occurredAt: now,
        commandId: CommandId.make("cmd-project-create-favicon"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-project-create-favicon"),
        metadata: {},
        payload: {
          projectId: asProjectId("project-favicon"),
          title: "Favicon",
          workspaceRoot: "/tmp/favicon",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });

      const result = yield* decideOrchestrationCommand({
        command: {
          type: "project.meta.update",
          commandId: CommandId.make("cmd-project-update-favicon"),
          projectId: asProjectId("project-favicon"),
          faviconPath: "brand/icon.svg",
        },
        readModel,
      });

      const event = Array.isArray(result) ? result[0] : result;
      expect(event.type).toBe("project.meta-updated");
      expect((event.payload as { faviconPath?: string }).faviconPath).toBe("brand/icon.svg");
    }),
  );

  it.effect("rejects project.create for an active workspace root that already exists", () =>
    Effect.gen(function* () {
      const now = "2026-01-01T00:00:00.000Z";
      const initial = createEmptyReadModel(now);
      const readModel = yield* projectEvent(initial, {
        sequence: 1,
        eventId: asEventId("evt-project-create"),
        aggregateKind: "project",
        aggregateId: asProjectId("project-existing"),
        type: "project.created",
        occurredAt: now,
        commandId: CommandId.make("cmd-project-create"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-project-create"),
        metadata: {},
        payload: {
          projectId: asProjectId("project-existing"),
          title: "Project",
          workspaceRoot: "/tmp/project",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });

      const failure = yield* Effect.flip(
        decideOrchestrationCommand({
          command: {
            type: "project.create",
            commandId: CommandId.make("cmd-project-create-duplicate-root"),
            projectId: asProjectId("project-duplicate-root"),
            title: "Duplicate Project",
            workspaceRoot: "/tmp/project/",
            createdAt: now,
          },
          readModel,
        }),
      );

      expect(failure.message).toContain(
        "Project 'project-existing' already owns workspace root '/tmp/project'.",
      );
    }),
  );

  it.effect("rejects project.create for a deleted project's workspace root", () =>
    Effect.gen(function* () {
      const now = "2026-01-01T00:00:00.000Z";
      const initial = createEmptyReadModel(now);
      const withProject = yield* projectEvent(initial, {
        sequence: 1,
        eventId: asEventId("evt-project-create-deleted-root"),
        aggregateKind: "project",
        aggregateId: asProjectId("project-deleted-root"),
        type: "project.created",
        occurredAt: now,
        commandId: CommandId.make("cmd-project-create-deleted-root"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-project-create-deleted-root"),
        metadata: {},
        payload: {
          projectId: asProjectId("project-deleted-root"),
          title: "Deleted Project",
          workspaceRoot: "/tmp/project-deleted-root",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });
      const readModel = yield* projectEvent(withProject, {
        sequence: 2,
        eventId: asEventId("evt-project-delete-root"),
        aggregateKind: "project",
        aggregateId: asProjectId("project-deleted-root"),
        type: "project.deleted",
        occurredAt: now,
        commandId: CommandId.make("cmd-project-delete-root"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-project-delete-root"),
        metadata: {},
        payload: { projectId: asProjectId("project-deleted-root"), deletedAt: now },
      });

      const failure = yield* Effect.flip(
        decideOrchestrationCommand({
          command: {
            type: "project.create",
            commandId: CommandId.make("cmd-project-reuse-deleted-root"),
            projectId: asProjectId("project-replacement"),
            title: "Replacement",
            workspaceRoot: "/tmp/project-deleted-root",
            createdAt: now,
          },
          readModel,
        }),
      );

      expect(failure.message).toContain(
        "Project 'project-deleted-root' already owns workspace root '/tmp/project-deleted-root'.",
      );
    }),
  );

  it.effect("rejects project.meta.update when moving onto another active workspace root", () =>
    Effect.gen(function* () {
      const now = "2026-01-01T00:00:00.000Z";
      const initial = createEmptyReadModel(now);
      const withFirstProject = yield* projectEvent(initial, {
        sequence: 1,
        eventId: asEventId("evt-project-create-first"),
        aggregateKind: "project",
        aggregateId: asProjectId("project-first"),
        type: "project.created",
        occurredAt: now,
        commandId: CommandId.make("cmd-project-create-first"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-project-create-first"),
        metadata: {},
        payload: {
          projectId: asProjectId("project-first"),
          title: "First",
          workspaceRoot: "/tmp/project-first",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });
      const readModel = yield* projectEvent(withFirstProject, {
        sequence: 2,
        eventId: asEventId("evt-project-create-second"),
        aggregateKind: "project",
        aggregateId: asProjectId("project-second"),
        type: "project.created",
        occurredAt: now,
        commandId: CommandId.make("cmd-project-create-second"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-project-create-second"),
        metadata: {},
        payload: {
          projectId: asProjectId("project-second"),
          title: "Second",
          workspaceRoot: "/tmp/project-second",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });

      const failure = yield* Effect.flip(
        decideOrchestrationCommand({
          command: {
            type: "project.meta.update",
            commandId: CommandId.make("cmd-project-update-duplicate-root"),
            projectId: asProjectId("project-second"),
            workspaceRoot: "/tmp/project-first",
          },
          readModel,
        }),
      );

      expect(failure.message).toContain(
        "Project 'project-first' already owns workspace root '/tmp/project-first'.",
      );
    }),
  );
});
