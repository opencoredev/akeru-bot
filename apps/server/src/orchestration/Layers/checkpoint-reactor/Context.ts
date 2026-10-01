import { ThreadId } from "@akeru/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { createDependencies } from "./Dependencies.ts";

export function createContext({
  agentController,
  projectionSnapshotQuery,
}: Pick<
  Effect.Success<ReturnType<typeof createDependencies>>,
  "agentController" | "projectionSnapshotQuery"
>) {
  const resolveSessionRuntimeForThread = Effect.fn("resolveSessionRuntimeForThread")(function* (
    threadId: ThreadId,
  ): Effect.fn.Return<Option.Option<{ readonly threadId: ThreadId; readonly cwd: string }>> {
    const sessions = yield* agentController.listSessions();
    const session = sessions.find((entry) => entry.threadId === threadId);

    return session?.cwd
      ? Option.some({ threadId: session.threadId, cwd: session.cwd })
      : Option.none();
  });

  // Reads only what checkpointing needs for an active thread: its session,
  // workspace location, and checkpoint summaries. Message history stays in SQLite.
  const resolveThreadCheckpointState = Effect.fn("resolveThreadCheckpointState")(function* (
    threadId: ThreadId,
  ) {
    const runtime = yield* projectionSnapshotQuery
      .getThreadRuntimeContext(threadId)
      .pipe(Effect.map(Option.getOrUndefined));

    if (!runtime) {
      return undefined;
    }

    const context = yield* projectionSnapshotQuery
      .getThreadCheckpointContext(threadId)
      .pipe(Effect.map(Option.getOrUndefined));

    if (!context) {
      return undefined;
    }

    return {
      id: context.threadId,
      projectId: context.projectId,
      worktreePath: context.worktreePath,
      checkpoints: context.checkpoints,
      session: runtime.session,
      projects: [{ id: context.projectId, workspaceRoot: context.workspaceRoot }],
    };
  });

  return { resolveSessionRuntimeForThread, resolveThreadCheckpointState };
}
