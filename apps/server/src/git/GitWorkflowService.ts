import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  GitManagerError,
  GitCommandError,
  type VcsCreateWorktreeInput,
  type VcsCreateWorktreeResult,
  type GitManagerServiceError,
} from "@akeru/contracts";

import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";

/**
 * Git operations behind per-chat worktree isolation: creating a chat's
 * worktree (optionally from origin), recreating a missing one, and renaming
 * its temporary branch once the first message names it.
 */
export class GitWorkflowService extends Context.Service<
  GitWorkflowService,
  {
    readonly createWorktree: (
      input: VcsCreateWorktreeInput,
    ) => Effect.Effect<VcsCreateWorktreeResult, GitCommandError>;
    readonly fetchRemote: (input: {
      readonly cwd: string;
      readonly remoteName: string;
    }) => Effect.Effect<void, GitCommandError>;
    readonly remoteExists: (input: {
      readonly cwd: string;
      readonly remoteName: string;
    }) => Effect.Effect<boolean, GitCommandError>;
    readonly resolveRemoteTrackingCommit: (input: {
      readonly cwd: string;
      readonly refName: string;
      readonly fallbackRemoteName: string;
    }) => Effect.Effect<
      { readonly commitSha: string; readonly remoteRefName: string },
      GitCommandError
    >;
    readonly pruneWorktrees: (input: {
      readonly cwd: string;
    }) => Effect.Effect<void, GitCommandError>;
    readonly renameBranch: (input: {
      readonly cwd: string;
      readonly oldBranch: string;
      readonly newBranch: string;
    }) => Effect.Effect<{ readonly branch: string }, GitManagerServiceError>;
  }
>()("akeru-bot/git/GitWorkflowService") {}

export const make = Effect.gen(function* () {
  const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
  const git = yield* GitVcsDriver.GitVcsDriver;

  const ensureGit = Effect.fn("GitWorkflowService.ensureGit")(function* (
    operation: string,
    cwd: string,
  ) {
    const handle = yield* registry.resolve({ cwd }).pipe(
      Effect.mapError(
        (cause) =>
          new GitManagerError({
            operation,
            cwd,
            detail: "Failed to resolve the VCS driver for this Git workflow.",
            cause,
          }),
      ),
    );
    if (handle.kind !== "git") {
      return yield* new GitManagerError({
        operation,
        cwd,
        detail: `The ${operation} workflow currently supports Git repositories only; detected ${handle.kind}. (${cwd})`,
      });
    }
  });

  const ensureGitCommand = Effect.fn("GitWorkflowService.ensureGitCommand")(function* (
    operation: string,
    cwd: string,
  ) {
    const handle = yield* registry.resolve({ cwd }).pipe(
      Effect.mapError(
        (cause) =>
          new GitCommandError({
            operation,
            command: "vcs-route",
            cwd,
            detail: "Failed to resolve the VCS driver for this Git command.",
            cause,
          }),
      ),
    );
    if (handle.kind !== "git") {
      return yield* new GitCommandError({
        operation,
        command: "vcs-route",
        cwd,
        detail: `The ${operation} command currently supports Git repositories only; detected ${handle.kind}.`,
      });
    }
  });

  return GitWorkflowService.of({
    createWorktree: (input) =>
      ensureGitCommand("GitWorkflowService.createWorktree", input.cwd).pipe(
        Effect.andThen(git.createWorktree(input)),
      ),
    fetchRemote: (input) =>
      ensureGitCommand("GitWorkflowService.fetchRemote", input.cwd).pipe(
        Effect.andThen(git.fetchRemote(input)),
      ),
    remoteExists: (input) =>
      ensureGitCommand("GitWorkflowService.remoteExists", input.cwd).pipe(
        Effect.andThen(git.remoteExists(input)),
      ),
    resolveRemoteTrackingCommit: (input) =>
      ensureGitCommand("GitWorkflowService.resolveRemoteTrackingCommit", input.cwd).pipe(
        Effect.andThen(git.resolveRemoteTrackingCommit(input)),
      ),
    pruneWorktrees: (input) =>
      ensureGitCommand("GitWorkflowService.pruneWorktrees", input.cwd).pipe(
        Effect.andThen(git.pruneWorktrees(input)),
      ),
    renameBranch: (input) =>
      ensureGit("GitWorkflowService.renameBranch", input.cwd).pipe(
        Effect.andThen(git.renameBranch(input)),
      ),
  });
});

export const layer = Layer.effect(GitWorkflowService, make);
