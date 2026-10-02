import {
  AkeruMemoryImportPreview,
  AkeruMemoryRootId,
  ThreadId,
  BotId,
  OrchestrationThreadShell,
  OrchestrationBot,
  OrchestrationShellSnapshot,
  Routine,
  RoutineRun,
  ServerProvider,
} from "@akeru/contracts";
import { Schema } from "effect";
import type {
  DurableImportReviewItem,
  DurableMemoryFact,
} from "@akeru/client-runtime/durable-memory";

export const decodeRoutine = Schema.decodeUnknownSync(Routine);

export const decodeRoutineRun = Schema.decodeUnknownSync(RoutineRun);

export const decodeServerProvider = Schema.decodeUnknownSync(ServerProvider);

export const decodeMemoryPreview = Schema.decodeUnknownSync(AkeruMemoryImportPreview);

const decodeSnapshot = Schema.decodeUnknownSync(OrchestrationShellSnapshot);

type ShellFixture = Omit<
  Partial<typeof OrchestrationShellSnapshot.Encoded>,
  "threads" | "routineRuns" | "bots"
> & {
  bots?: ReadonlyArray<Partial<typeof OrchestrationBot.Encoded>> | undefined;
  threads?: ReadonlyArray<Partial<typeof OrchestrationThreadShell.Encoded>> | undefined;
  routineRuns?: ReadonlyArray<Partial<typeof RoutineRun.Encoded>> | undefined;
};

export function makeShellSnapshot(overrides: ShellFixture) {
  return decodeSnapshot({
    snapshotSequence: 0,
    projects: [],
    groups: [],
    delegations: [],
    updatedAt: "2026-09-29T09:00:00.000Z",
    ...overrides,
    bots: (overrides.bots ?? []).map((bot) => ({
      title: "Fixture teammate",
      avatar: { kind: "blob", shape: "circle", color: "#2E8EFF" },
      engine: null,
      sandbox: "local",
      groupId: null,
      archivedAt: null,
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-29T09:00:00.000Z",
      ...bot,
    })),
    threads: (overrides.threads ?? []).map((thread) => ({
      id: "thread-1",
      projectId: "project-1",
      title: "Fixture chat",
      modelSelection: { instanceId: "codex", model: "gpt-5" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      latestTurn: null,
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-29T09:00:00.000Z",
      session: null,
      latestUserMessageAt: null,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      hasActionableProposedPlan: false,
      ...thread,
    })),
    ...(overrides.routineRuns === undefined
      ? {}
      : {
          routineRuns: overrides.routineRuns.map((run) => ({
            id: "run-1",
            routineId: "routine-1",
            procedureVersion: 1,
            status: "queued",
            trigger: "manual",
            scheduledFor: null,
            result: null,
            failure: null,
            usageRef: null,
            threadRef: null,
            startedAt: null,
            completedAt: null,
            createdAt: "2026-09-29T09:00:00.000Z",
            updatedAt: "2026-09-29T09:00:00.000Z",
            ...run,
          })),
        }),
  });
}

export function makeReviewItem(
  item: Omit<DurableImportReviewItem, "rootId"> & { rootId: string },
): DurableImportReviewItem {
  return { ...item, rootId: AkeruMemoryRootId.make(item.rootId) };
}

export type DurableFactFixture = Omit<
  DurableMemoryFact,
  "rootId" | "sourceThreadId" | "affectedBotIds"
> & { rootId: string; sourceThreadId: string | null; affectedBotIds: ReadonlyArray<string> };

export function makeDurableFact(fact: DurableFactFixture): DurableMemoryFact {
  return {
    ...fact,
    rootId: AkeruMemoryRootId.make(fact.rootId),
    sourceThreadId: fact.sourceThreadId === null ? null : ThreadId.make(fact.sourceThreadId),
    affectedBotIds: fact.affectedBotIds.map((id) => BotId.make(id)),
  };
}

export type RuntimeThreadFixture = Omit<
  Partial<typeof OrchestrationThreadShell.Encoded>,
  "latestTurn" | "session"
> & {
  environmentId?: string;
  latestTurn?: Partial<NonNullable<(typeof OrchestrationThreadShell.Encoded)["latestTurn"]>> | null;
  session?: Partial<NonNullable<(typeof OrchestrationThreadShell.Encoded)["session"]>> | null;
};

export type RuntimeProjectFixture = Partial<
  typeof import("@akeru/contracts").OrchestrationProject.Encoded
> & { environmentId?: string };
