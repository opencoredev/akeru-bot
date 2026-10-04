import {
  BotId,
  ProjectId,
  ThreadId,
  type OrchestrationBot,
  type OrchestrationThread,
} from "@akeru/contracts";
import * as Effect from "effect/Effect";
import { createEmptyReadModel } from "../../../orchestration/projector.ts";
import type {
  ProjectionSnapshotQueryShape,
  ProjectionThreadRuntimeContext,
} from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";

const now = "2026-09-01T00:00:00.000Z";

export const emptyProviderSnapshot = () => createEmptyReadModel(now);

export function providerBotFixture(
  input: Pick<OrchestrationBot, "id"> & Partial<OrchestrationBot>,
): OrchestrationBot {
  return {
    name: input.id,
    title: "Agent",
    label: null,
    description: null,
    disabledMcpServerIds: [],
    avatar: { kind: "dither", seed: input.id },
    engine: null,
    sandbox: "local",
    runtimeMode: "full-access",
    imageProvider: null,
    voiceEnabled: false,
    channelBindings: [],
    groupId: null,
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
    ...input,
  };
}

export function providerThreadFixture(
  input: Pick<OrchestrationThread, "id" | "modelSelection"> & Partial<OrchestrationThread>,
): OrchestrationThread {
  return {
    projectId: ProjectId.make("provider-fixture"),
    botId: null,
    groupId: null,
    respondingBotId: null,
    title: "Fixture chat",
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: null,
    ...input,
  };
}

export function providerRuntimeContext(
  input: Partial<ProjectionThreadRuntimeContext>,
): ProjectionThreadRuntimeContext {
  return {
    id: ThreadId.make("provider-fixture"),
    title: "Fixture chat",
    session: null,
    projectId: ProjectId.make("provider-fixture"),
    botId: BotId.make("provider-fixture"),
    groupId: null,
    respondingBotId: null,
    runtimeMode: "full-access",
    ...input,
  };
}

export function projectionQueryFixture(
  overrides: Partial<ProjectionSnapshotQueryShape>,
): ProjectionSnapshotQueryShape {
  const unused = () => Effect.die(new Error("Unexpected projection query in provider fixture"));

  return {
    getCommandReadModel: unused,
    getSnapshot: unused,
    getShellSnapshot: unused,
    getArchivedShellSnapshot: unused,
    searchThreads: unused,
    getSnapshotSequence: unused,
    getCounts: unused,
    getEventReplayStats: unused,
    getActiveProjectByWorkspaceRoot: unused,
    getOriginalProjectIdByWorkspaceRoot: unused,
    getProjectShellById: unused,
    getFirstActiveThreadIdByProjectId: unused,
    getThreadCheckpointContext: unused,
    getFullThreadDiffContext: unused,
    getThreadShellById: unused,
    getThreadRuntimeContext: unused,
    getTurnStartMessage: unused,
    getThreadDetailById: unused,
    getThreadDetailSnapshot: unused,
    ...overrides,
  };
}
