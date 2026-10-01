// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { ProviderDriverKind } from "@akeru/contracts";
import { CommandId, EventId, ThreadId } from "@akeru/contracts";
import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { afterEach, describe, expect } from "vite-plus/test";
import { checkpointRefForThreadTurn } from "../../checkpointing/Utils.ts";
import {
  createGitRepository,
  runGit,
  asTurnId,
  gitRefExists,
  createCheckpointHarness,
} from "./test-support/CheckpointHarness.ts";

describe("CheckpointReactor", () => {
  const testScope = createCheckpointHarness();
  const { tempDirs, createHarness } = testScope;
  afterEach(testScope.dispose);
  effectIt.effect("captures and reverts checkpoints from a nested Git workspace", () =>
    Effect.gen(function* () {
      const repositoryRoot = createGitRepository();
      tempDirs.push(repositoryRoot);
      const workspaceRoot = NodePath.join(repositoryRoot, "apps", "server");
      NodeFS.mkdirSync(workspaceRoot, { recursive: true });
      const filePath = NodePath.join(workspaceRoot, "index.ts");
      NodeFS.writeFileSync(filePath, "export const value = 1;\n");
      runGit(repositoryRoot, ["add", "."]);
      runGit(repositoryRoot, ["commit", "-m", "Add nested workspace"]);

      const harness = yield* Effect.promise(() =>
        createHarness({
          seedFilesystemCheckpoints: false,
          projectWorkspaceRoot: workspaceRoot,
          threadWorktreePath: workspaceRoot,
          providerSessionCwd: workspaceRoot,
        }),
      );

      const threadId = ThreadId.make("thread-1");
      const turnId = asTurnId("turn-nested");
      const createdAt = "2026-01-01T00:00:00.000Z";
      harness.provider.emit({
        type: "turn.started",
        eventId: EventId.make("evt-nested-start"),
        provider: ProviderDriverKind.make("codex"),
        createdAt,
        threadId,
        turnId,
      });
      yield* Effect.promise(harness.drain);
      expect(gitRefExists(repositoryRoot, checkpointRefForThreadTurn(threadId, 0))).toBe(true);
      expect(yield* harness.nextReceipt).toMatchObject({
        type: "checkpoint.baseline.captured",
      });

      NodeFS.writeFileSync(filePath, "export const value = 2;\n");
      harness.provider.emit({
        type: "turn.completed",
        eventId: EventId.make("evt-nested-complete"),
        provider: ProviderDriverKind.make("codex"),
        createdAt,
        threadId,
        turnId,
        payload: { state: "completed" },
      });
      yield* Effect.promise(harness.drain);

      const thread = (yield* Effect.promise(harness.readModel)).threads.find(
        (entry) => entry.id === threadId,
      );

      expect(thread?.checkpoints[0]).toMatchObject({
        status: "ready",
        files: [{ path: "apps/server/index.ts", additions: 1, deletions: 1 }],
      });
      expect(yield* harness.nextReceipt).toMatchObject({
        type: "checkpoint.diff.finalized",
        turnId,
      });
      expect(yield* harness.nextReceipt).toMatchObject({ type: "turn.processing.quiesced" });

      yield* harness.engine.dispatch({
        type: "thread.checkpoint.revert",
        commandId: CommandId.make("cmd-nested-revert"),
        threadId,
        turnCount: 0,
        createdAt,
      });
      yield* Effect.promise(harness.drain);
      expect(NodeFS.readFileSync(filePath, "utf8")).toBe("export const value = 1;\n");
      expect(harness.provider.rollbackConversation).toHaveBeenCalledWith({ threadId, numTurns: 1 });
      expect(gitRefExists(repositoryRoot, checkpointRefForThreadTurn(threadId, 1))).toBe(false);

      const reverted = (yield* Effect.promise(harness.readModel)).threads.find(
        (entry) => entry.id === threadId,
      );

      expect(reverted?.checkpoints).toEqual([]);
    }),
  );

  effectIt.effect("keeps nested workspace summaries free of sibling parent commits", () =>
    Effect.gen(function* () {
      const repositoryRoot = createGitRepository();
      tempDirs.push(repositoryRoot);
      const workspaceRoot = NodePath.join(repositoryRoot, "apps", "server");
      const siblingRoot = NodePath.join(repositoryRoot, "apps", "web");
      NodeFS.mkdirSync(workspaceRoot, { recursive: true });
      NodeFS.mkdirSync(siblingRoot, { recursive: true });
      const filePath = NodePath.join(workspaceRoot, "index.ts");
      NodeFS.writeFileSync(filePath, "export const value = 1;\n");
      NodeFS.writeFileSync(NodePath.join(siblingRoot, "page.ts"), "export const page = 1;\n");
      runGit(repositoryRoot, ["add", "."]);
      runGit(repositoryRoot, ["commit", "-m", "Add nested workspaces"]);

      const harness = yield* Effect.promise(() =>
        createHarness({
          seedFilesystemCheckpoints: false,
          projectWorkspaceRoot: workspaceRoot,
          threadWorktreePath: workspaceRoot,
          providerSessionCwd: workspaceRoot,
        }),
      );

      const threadId = ThreadId.make("thread-1");
      const turnId = asTurnId("turn-nested-sibling");
      const createdAt = "2026-01-01T00:00:00.000Z";
      harness.provider.emit({
        type: "turn.started",
        eventId: EventId.make("evt-nested-sibling-start"),
        provider: ProviderDriverKind.make("codex"),
        createdAt,
        threadId,
        turnId,
      });
      yield* Effect.promise(harness.drain);
      expect(yield* harness.nextReceipt).toMatchObject({
        type: "checkpoint.baseline.captured",
      });

      NodeFS.writeFileSync(filePath, "export const value = 2;\n");
      NodeFS.writeFileSync(NodePath.join(siblingRoot, "page.ts"), "export const page = 2;\n");
      runGit(repositoryRoot, ["add", "apps/web/page.ts"]);
      runGit(repositoryRoot, ["commit", "-m", "Sibling commit"]);
      harness.provider.emit({
        type: "turn.completed",
        eventId: EventId.make("evt-nested-sibling-complete"),
        provider: ProviderDriverKind.make("codex"),
        createdAt,
        threadId,
        turnId,
        payload: { state: "completed" },
      });
      yield* Effect.promise(harness.drain);

      const thread = (yield* Effect.promise(harness.readModel)).threads.find(
        (entry) => entry.id === threadId,
      );

      expect(thread?.checkpoints[0]).toMatchObject({
        status: "ready",
        files: [{ path: "apps/server/index.ts", additions: 1, deletions: 1 }],
      });
      expect(thread?.checkpoints[0]?.files.some((file) => file.path.includes("apps/web"))).toBe(
        false,
      );
      expect(yield* harness.nextReceipt).toMatchObject({
        type: "checkpoint.diff.finalized",
        turnId,
      });
      expect(yield* harness.nextReceipt).toMatchObject({ type: "turn.processing.quiesced" });
    }),
  );
});
