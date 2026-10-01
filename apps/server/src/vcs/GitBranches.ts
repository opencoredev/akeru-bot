import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { GitCommandError } from "@akeru/contracts";
import { parseRemoteNames } from "../git/remoteRefs.ts";
import {
  STATUS_UPSTREAM_REFRESH_TIMEOUT,
  STATUS_UPSTREAM_REFRESH_ENV,
  parseUpstreamRefWithRemoteNames,
  parseUpstreamRefByFirstSeparator,
  gitCommandContext,
} from "./GitCoreHelpers.ts";
import type { GitExecutionServices } from "./GitExecution.ts";

export const makeGitBranches = (dependencies: {
  path: GitExecutionServices["path"];
  executeGit: GitExecutionServices["executeGit"];
  runGitStdout: GitExecutionServices["runGitStdout"];
}) =>
  Effect.sync(() => {
    const { path, executeGit, runGitStdout } = dependencies;

    const branchExists = (cwd: string, refName: string): Effect.Effect<boolean, GitCommandError> =>
      executeGit(
        "GitVcsDriver.branchExists",
        cwd,
        ["show-ref", "--verify", "--quiet", `refs/heads/${refName}`],
        {
          allowNonZeroExit: true,
          timeoutMs: 5_000,
        },
      ).pipe(Effect.map((result) => result.exitCode === 0));

    const resolveAvailableBranchName = Effect.fn("resolveAvailableBranchName")(function* (
      cwd: string,
      desiredBranch: string,
    ) {
      const isDesiredTaken = yield* branchExists(cwd, desiredBranch);

      if (!isDesiredTaken) {
        return desiredBranch;
      }

      for (let suffix = 1; suffix <= 100; suffix += 1) {
        const candidate = `${desiredBranch}-${suffix}`;
        const isCandidateTaken = yield* branchExists(cwd, candidate);

        if (!isCandidateTaken) {
          return candidate;
        }
      }

      return yield* new GitCommandError({
        ...gitCommandContext({
          operation: "GitVcsDriver.renameBranch",
          cwd,
          args: ["branch", "-m", "--", desiredBranch],
        }),
        detail: `Could not find an available branch name for '${desiredBranch}'.`,
      });
    });

    const resolveCurrentUpstream = Effect.fn("resolveCurrentUpstream")(function* (cwd: string) {
      const upstreamRef = yield* runGitStdout(
        "GitVcsDriver.resolveCurrentUpstream",
        cwd,
        ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
        true,
      ).pipe(Effect.map((stdout) => stdout.trim()));

      if (upstreamRef.length === 0 || upstreamRef === "@{upstream}") {
        return null;
      }

      const remoteNames = yield* runGitStdout("GitVcsDriver.listRemoteNames", cwd, ["remote"]).pipe(
        Effect.map(parseRemoteNames),
        Effect.orElseSucceed((): ReadonlyArray<string> => []),
      );

      return (
        parseUpstreamRefWithRemoteNames(upstreamRef, remoteNames) ??
        parseUpstreamRefByFirstSeparator(upstreamRef)
      );
    });

    const fetchRemoteForStatus = (
      gitCommonDir: string,
      remoteName: string,
    ): Effect.Effect<void, GitCommandError> => {
      const fetchCwd =
        path.basename(gitCommonDir) === ".git" ? path.dirname(gitCommonDir) : gitCommonDir;

      return executeGit(
        "GitVcsDriver.fetchRemoteForStatus",
        fetchCwd,
        ["--git-dir", gitCommonDir, "fetch", "--quiet", "--no-tags", remoteName],
        {
          env: STATUS_UPSTREAM_REFRESH_ENV,
          fallbackErrorDetail: "Background Git fetch exited with a non-zero status.",
          timeoutMs: Duration.toMillis(STATUS_UPSTREAM_REFRESH_TIMEOUT),
        },
      ).pipe(Effect.asVoid);
    };

    return {
      branchExists,
      resolveAvailableBranchName,
      resolveCurrentUpstream,
      fetchRemoteForStatus,
    };
  });

export type GitBranchesServices = Effect.Success<ReturnType<typeof makeGitBranches>>;
