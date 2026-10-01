import { ServerConfig } from "../config.ts";
import * as Effect from "effect/Effect";
import { GitCommandError } from "@akeru/contracts";
import type * as GitVcsDriver from "./GitVcsDriver.ts";
import { parseRemoteRefWithRemoteNames } from "../git/remoteRefs.ts";
import {
  WORKTREE_ADD_TIMEOUT_MS,
  STATUS_UPSTREAM_REFRESH_ENV,
  parseTrackingBranchByUpstreamRef,
  deriveLocalBranchNameFromRemoteRef,
  gitCommandContext,
  isMissingWorktreeStderr,
} from "./GitCoreHelpers.ts";
import type { makeGitExecution } from "./GitExecution.ts";
import type { makeGitBranches } from "./GitBranches.ts";
import type { makeGitRemoteStatus } from "./GitRemoteStatus.ts";

export const makeGitWorktrees = (dependencies: {
  fileSystem: Effect.Success<ReturnType<typeof makeGitExecution>>["fileSystem"];
  path: Effect.Success<ReturnType<typeof makeGitExecution>>["path"];
  executeGit: Effect.Success<ReturnType<typeof makeGitExecution>>["executeGit"];
  executeGitWithStableDiagnostics: Effect.Success<
    ReturnType<typeof makeGitExecution>
  >["executeGitWithStableDiagnostics"];
  runGit: Effect.Success<ReturnType<typeof makeGitExecution>>["runGit"];
  runGitStdout: Effect.Success<ReturnType<typeof makeGitExecution>>["runGitStdout"];
  resolveAvailableBranchName: Effect.Success<
    ReturnType<typeof makeGitBranches>
  >["resolveAvailableBranchName"];
  remoteExists: Effect.Success<ReturnType<typeof makeGitRemoteStatus>>["remoteExists"];
  listRemoteNames: Effect.Success<ReturnType<typeof makeGitRemoteStatus>>["listRemoteNames"];
}) =>
  Effect.gen(function* () {
    const { worktreesDir } = yield* ServerConfig;

    const {
      fileSystem,
      path,
      executeGit,
      executeGitWithStableDiagnostics,
      runGit,
      runGitStdout,
      resolveAvailableBranchName,
      listRemoteNames,
    } = dependencies;

    const createWorktree: GitVcsDriver.GitVcsDriver["Service"]["createWorktree"] = Effect.fn(
      "createWorktree",
    )(function* (input) {
      const targetBranch = input.newRefName ?? input.refName;
      const sanitizedBranch = targetBranch.replace(/\//g, "-");
      const repoName = path.basename(input.cwd);
      const worktreePath = input.path ?? path.join(worktreesDir, repoName, sanitizedBranch);

      const args = input.newRefName
        ? ["worktree", "add", "-b", input.newRefName, worktreePath, input.refName]
        : ["worktree", "add", worktreePath, input.refName];

      yield* executeGit("GitVcsDriver.createWorktree", input.cwd, args, {
        fallbackErrorDetail: "git worktree add failed",
        timeoutMs: WORKTREE_ADD_TIMEOUT_MS,
      });

      // `git worktree add` leaves submodules empty, so a repo that keeps agent
      // skills, tooling or source in one gets a worktree that is quietly missing
      // them. Best-effort: the objects are usually already in the parent's
      // `.git/modules`, but a first-ever clone needs the network, and failing to
      // populate a submodule must not roll back the caller's thread.
      const hasSubmodules = yield* fileSystem
        .exists(path.join(worktreePath, ".gitmodules"))
        .pipe(Effect.orElseSucceed(() => false));

      if (hasSubmodules) {
        yield* runGit("GitVcsDriver.createWorktree.updateSubmodules", worktreePath, [
          "submodule",
          "update",
          "--init",
          "--recursive",
        ]).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("worktree submodule checkout failed; submodule paths are empty", {
              worktreePath,
              cause,
            }),
          ),
        );
      }

      if (input.newRefName && input.baseRefName) {
        const remoteNames = yield* listRemoteNames(input.cwd).pipe(Effect.orElseSucceed(() => []));

        const parsedBaseRef = parseRemoteRefWithRemoteNames(
          input.baseRefName,
          remoteNames.toSorted((left, right) => right.length - left.length),
        );

        const baseBranch = parsedBaseRef?.branchName ?? input.baseRefName;
        yield* runGit("GitVcsDriver.createWorktree.configureBaseRef", input.cwd, [
          "config",
          `branch.${input.newRefName}.gh-merge-base`,
          baseBranch,
        ]);
      }

      return {
        worktree: {
          path: worktreePath,
          refName: targetBranch,
        },
      };
    });

    const fetchRemote: GitVcsDriver.GitVcsDriver["Service"]["fetchRemote"] = Effect.fn(
      "fetchRemote",
    )(function* (input) {
      yield* executeGit(
        "GitVcsDriver.fetchRemote",
        input.cwd,
        ["fetch", "--quiet", input.remoteName],
        {
          env: STATUS_UPSTREAM_REFRESH_ENV,
          fallbackErrorDetail: `git fetch ${input.remoteName} failed`,
        },
      );
    });

    const resolveRemoteTrackingCommit: GitVcsDriver.GitVcsDriver["Service"]["resolveRemoteTrackingCommit"] =
      Effect.fn("resolveRemoteTrackingCommit")(function* (input) {
        const remoteNames = yield* listRemoteNames(input.cwd);

        const parsedRemoteRef = parseRemoteRefWithRemoteNames(
          input.refName,
          remoteNames.toSorted((left, right) => right.length - left.length),
        );

        const remoteRefName =
          parsedRemoteRef?.remoteRef ?? `${input.fallbackRemoteName}/${input.refName}`;

        const commitSha = yield* runGitStdout(
          "GitVcsDriver.resolveRemoteTrackingCommit",
          input.cwd,
          ["rev-parse", "--verify", `refs/remotes/${remoteRefName}^{commit}`],
        ).pipe(Effect.map((stdout) => stdout.trim()));

        return { commitSha, remoteRefName };
      });

    const fetchRemoteTrackingBranch: GitVcsDriver.GitVcsDriver["Service"]["fetchRemoteTrackingBranch"] =
      Effect.fn("fetchRemoteTrackingBranch")(function* (input) {
        yield* runGit("GitVcsDriver.fetchRemoteTrackingBranch", input.cwd, [
          "fetch",
          "--quiet",
          "--no-tags",
          input.remoteName,
          `+refs/heads/${input.remoteBranch}:refs/remotes/${input.remoteName}/${input.remoteBranch}`,
        ]);
      });

    const removeWorktree: GitVcsDriver.GitVcsDriver["Service"]["removeWorktree"] = Effect.fn(
      "removeWorktree",
    )(function* (input) {
      const args = ["worktree", "remove"];

      if (input.force) {
        args.push("--force");
      }

      args.push(input.path);

      const result = yield* executeGitWithStableDiagnostics(
        "GitVcsDriver.removeWorktree",
        input.cwd,
        args,
        { timeoutMs: 15_000, allowNonZeroExit: true },
      );

      if (result.exitCode === 0) {
        return;
      }

      // Threads can share a worktree path, and worktrees get removed or pruned
      // outside the app, so a worktree that is already gone is a no-op rather
      // than an error. Prune so no stale registration lingers to block a later
      // `worktree add` at the same path.
      const alreadyGone =
        isMissingWorktreeStderr(result.stderr) &&
        !(yield* fileSystem.exists(input.path).pipe(Effect.orElseSucceed(() => false)));

      if (alreadyGone) {
        yield* pruneWorktrees({ cwd: input.cwd });

        return;
      }

      // Raw stderr stays out of both the wire error and the log (it can carry
      // secrets); log bounded diagnostics so a genuine failure is visible
      // server-side.
      yield* Effect.logWarning(
        `GitVcsDriver.removeWorktree: git worktree remove exited with code ${result.exitCode} for ${input.path} (stderr length ${result.stderr.length}).`,
      );

      return yield* new GitCommandError({
        ...gitCommandContext({ operation: "GitVcsDriver.removeWorktree", cwd: input.cwd, args }),
        detail: "git worktree remove failed",
        ...(result.exitCode === null ? {} : { exitCode: result.exitCode }),
        stdoutLength: result.stdout.length,
        stderrLength: result.stderr.length,
      });
    });

    const pruneWorktrees: GitVcsDriver.GitVcsDriver["Service"]["pruneWorktrees"] = Effect.fn(
      "pruneWorktrees",
    )(function* (input) {
      yield* executeGit("GitVcsDriver.pruneWorktrees", input.cwd, ["worktree", "prune"], {
        timeoutMs: 15_000,
        fallbackErrorDetail: "git worktree prune failed",
      });
    });

    const renameBranch: GitVcsDriver.GitVcsDriver["Service"]["renameBranch"] = Effect.fn(
      "renameBranch",
    )(function* (input) {
      if (input.oldBranch === input.newBranch) {
        return { branch: input.newBranch };
      }

      const targetBranch = yield* resolveAvailableBranchName(input.cwd, input.newBranch);

      yield* executeGit(
        "GitVcsDriver.renameBranch",
        input.cwd,
        ["branch", "-m", "--", input.oldBranch, targetBranch],
        {
          timeoutMs: 10_000,
          fallbackErrorDetail: "git branch rename failed",
        },
      );

      return { branch: targetBranch };
    });

    const switchRef: GitVcsDriver.GitVcsDriver["Service"]["switchRef"] = Effect.fn("switchRef")(
      function* (input) {
        const [localInputExists, remoteExists] = yield* Effect.all(
          [
            executeGit(
              "GitVcsDriver.switchRef.localInputExists",
              input.cwd,
              ["show-ref", "--verify", "--quiet", `refs/heads/${input.refName}`],
              {
                timeoutMs: 5_000,
                allowNonZeroExit: true,
              },
            ).pipe(Effect.map((result) => result.exitCode === 0)),
            executeGit(
              "GitVcsDriver.switchRef.remoteExists",
              input.cwd,
              ["show-ref", "--verify", "--quiet", `refs/remotes/${input.refName}`],
              {
                timeoutMs: 5_000,
                allowNonZeroExit: true,
              },
            ).pipe(Effect.map((result) => result.exitCode === 0)),
          ],
          { concurrency: "unbounded" },
        );

        const localTrackingBranch = remoteExists
          ? yield* executeGit(
              "GitVcsDriver.switchRef.localTrackingBranch",
              input.cwd,
              ["for-each-ref", "--format=%(refname:short)\t%(upstream:short)", "refs/heads"],
              {
                timeoutMs: 5_000,
                allowNonZeroExit: true,
              },
            ).pipe(
              Effect.map((result) =>
                result.exitCode === 0
                  ? parseTrackingBranchByUpstreamRef(result.stdout, input.refName)
                  : null,
              ),
            )
          : null;

        const localTrackedBranchCandidate = deriveLocalBranchNameFromRemoteRef(input.refName);

        const localTrackedBranchTargetExists =
          remoteExists && localTrackedBranchCandidate
            ? yield* executeGit(
                "GitVcsDriver.switchRef.localTrackedBranchTargetExists",
                input.cwd,
                ["show-ref", "--verify", "--quiet", `refs/heads/${localTrackedBranchCandidate}`],
                {
                  timeoutMs: 5_000,
                  allowNonZeroExit: true,
                },
              ).pipe(Effect.map((result) => result.exitCode === 0))
            : false;

        const checkoutArgs = localInputExists
          ? ["checkout", input.refName]
          : remoteExists && !localTrackingBranch && localTrackedBranchTargetExists
            ? ["checkout", input.refName]
            : remoteExists && !localTrackingBranch
              ? ["checkout", "--track", input.refName]
              : remoteExists && localTrackingBranch
                ? ["checkout", localTrackingBranch]
                : ["checkout", input.refName];

        yield* executeGit("GitVcsDriver.switchRef.checkout", input.cwd, checkoutArgs, {
          timeoutMs: 10_000,
          fallbackErrorDetail: "git checkout failed",
        });

        const refName = yield* runGitStdout("GitVcsDriver.switchRef.currentBranch", input.cwd, [
          "branch",
          "--show-current",
        ]).pipe(Effect.map((stdout) => stdout.trim() || null));

        return { refName };
      },
    );

    const createRef: GitVcsDriver.GitVcsDriver["Service"]["createRef"] = Effect.fn("createRef")(
      function* (input) {
        yield* executeGit("GitVcsDriver.createRef", input.cwd, ["branch", input.refName], {
          timeoutMs: 10_000,
          fallbackErrorDetail: "git branch create failed",
        });

        if (input.switchRef) {
          yield* switchRef({ cwd: input.cwd, refName: input.refName });
        }

        return { refName: input.refName };
      },
    );

    const initRepo: GitVcsDriver.GitVcsDriver["Service"]["initRepo"] = (input) =>
      executeGit("GitVcsDriver.initRepo", input.cwd, ["init"], {
        timeoutMs: 10_000,
        fallbackErrorDetail: "git init failed",
      }).pipe(Effect.asVoid);

    return {
      createWorktree,
      fetchRemote,
      resolveRemoteTrackingCommit,
      fetchRemoteTrackingBranch,
      removeWorktree,
      pruneWorktrees,
      renameBranch,
      switchRef,
      createRef,
      initRepo,
    };
  });
