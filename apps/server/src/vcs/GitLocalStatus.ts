import * as Cache from "effect/Cache";
import * as Effect from "effect/Effect";
import { GitCommandError } from "@akeru/contracts";
import type * as GitVcsDriver from "./GitVcsDriver.ts";
import {
  NON_REPOSITORY_STATUS_DETAILS,
  parseBranchAb,
  parseNumstatEntries,
  parsePorcelainPath,
  gitCommandContext,
  isMissingGitCwdError,
  isNonRepositoryGitStderr,
  isUnbornHeadStderr,
} from "./GitCoreHelpers.ts";
import type { GitExecutionServices } from "./GitExecution.ts";
import type { GitRepositoryPathsServices } from "./GitRepositoryPaths.ts";
import type { GitRemoteStatusServices } from "./GitRemoteStatus.ts";

export const makeGitLocalStatus = (dependencies: {
  executeGitWithStableDiagnostics: GitExecutionServices["executeGitWithStableDiagnostics"];
  runGitStdout: GitExecutionServices["runGitStdout"];
  resolveRepositoryPaths: GitRepositoryPathsServices["resolveRepositoryPaths"];
  defaultBranchCache: GitRemoteStatusServices["defaultBranchCache"];
  originExistsCache: GitRemoteStatusServices["originExistsCache"];
  refreshStatusUpstreamIfStale: GitRemoteStatusServices["refreshStatusUpstreamIfStale"];
  resolveDefaultBranchName: GitRemoteStatusServices["resolveDefaultBranchName"];
  originRemoteExists: GitRemoteStatusServices["originRemoteExists"];
  computeAheadCountAgainstBase: GitRemoteStatusServices["computeAheadCountAgainstBase"];
  readStatusDetailsRemote: GitRemoteStatusServices["readStatusDetailsRemote"];
}) =>
  Effect.sync(() => {
    const {
      executeGitWithStableDiagnostics,
      runGitStdout,
      resolveRepositoryPaths,
      defaultBranchCache,
      originExistsCache,
      refreshStatusUpstreamIfStale,
      resolveDefaultBranchName,
      originRemoteExists,
      computeAheadCountAgainstBase,
      readStatusDetailsRemote,
    } = dependencies;

    const readStatusDetailsLocal = Effect.fn("readStatusDetailsLocal")(function* (cwd: string) {
      const statusResult = yield* executeGitWithStableDiagnostics(
        "GitVcsDriver.statusDetails.status",
        cwd,
        ["status", "--porcelain=2", "--branch"],
        {
          allowNonZeroExit: true,
        },
      ).pipe(
        Effect.catchTags({
          GitCommandError: (error) =>
            isMissingGitCwdError(error) ? Effect.succeed(null) : Effect.fail(error),
        }),
      );

      if (statusResult === null) {
        return NON_REPOSITORY_STATUS_DETAILS;
      }

      if (statusResult.exitCode !== 0) {
        if (isNonRepositoryGitStderr(statusResult.stderr)) {
          return NON_REPOSITORY_STATUS_DETAILS;
        }

        return yield* new GitCommandError({
          ...gitCommandContext({
            operation: "GitVcsDriver.statusDetails.status",
            cwd,
            args: ["status", "--porcelain=2", "--branch"],
          }),
          detail: "Git status failed.",
          exitCode: statusResult.exitCode,
          stdoutLength: statusResult.stdout.length,
          stderrLength: statusResult.stderr.length,
        });
      }

      const repositoryPaths = yield* resolveRepositoryPaths(cwd).pipe(
        Effect.catchTags({ GitCommandError: () => Effect.succeed(null) }),
      );

      const statusCacheKey = repositoryPaths?.gitCommonDir;

      const [numstatStdout, defaultBranch, hasPrimaryRemote] = yield* Effect.all(
        [
          executeGitWithStableDiagnostics(
            "GitVcsDriver.statusDetails.numstat",
            cwd,
            ["diff", "HEAD", "--numstat", "--"],
            { allowNonZeroExit: true },
          ).pipe(
            Effect.flatMap((result) => {
              if (result.exitCode === 0) return Effect.succeed(result.stdout);

              if (isUnbornHeadStderr(result.stderr)) {
                return Effect.map(
                  Effect.all([
                    runGitStdout("GitVcsDriver.statusDetails.numstat.unborn", cwd, [
                      "diff",
                      "--numstat",
                    ]),
                    runGitStdout("GitVcsDriver.statusDetails.numstat.unborn.staged", cwd, [
                      "diff",
                      "--cached",
                      "--numstat",
                    ]),
                  ]),
                  ([unstagedStdout, stagedStdout]) => {
                    const staged = parseNumstatEntries(stagedStdout);
                    const unstaged = parseNumstatEntries(unstagedStdout);
                    const map = new Map<string, { insertions: number; deletions: number }>();

                    for (const entry of [...staged, ...unstaged]) {
                      const existing = map.get(entry.path) ?? {
                        insertions: 0,
                        deletions: 0,
                      };

                      existing.insertions += entry.insertions;
                      existing.deletions += entry.deletions;
                      map.set(entry.path, existing);
                    }

                    return Array.from(map.entries())
                      .map(([p, s]) => `${s.insertions}\t${s.deletions}\t${p}`)
                      .join("\n");
                  },
                );
              }

              return Effect.fail(
                new GitCommandError({
                  ...gitCommandContext({
                    operation: "GitVcsDriver.statusDetails.numstat",
                    cwd,
                    args: ["diff", "HEAD", "--numstat", "--"],
                  }),
                  detail: "git diff HEAD --numstat failed.",
                  exitCode: result.exitCode,
                  stdoutLength: result.stdout.length,
                  stderrLength: result.stderr.length,
                }),
              );
            }),
          ),
          statusCacheKey
            ? Cache.get(defaultBranchCache, statusCacheKey).pipe(Effect.orElseSucceed(() => null))
            : resolveDefaultBranchName(cwd, "origin").pipe(Effect.orElseSucceed(() => null)),
          statusCacheKey
            ? Cache.get(originExistsCache, statusCacheKey).pipe(Effect.orElseSucceed(() => false))
            : originRemoteExists(cwd).pipe(Effect.orElseSucceed(() => false)),
        ],
        { concurrency: "unbounded" },
      );

      const statusStdout = statusResult.stdout;

      let refName: string | null = null;
      let upstreamRef: string | null = null;
      let aheadCount = 0;
      let behindCount = 0;
      let aheadOfDefaultCount = 0;
      let hasWorkingTreeChanges = false;
      const changedFilesWithoutNumstat = new Set<string>();

      for (const line of statusStdout.split(/\r?\n/g)) {
        if (line.startsWith("# branch.head ")) {
          const value = line.slice("# branch.head ".length).trim();
          refName = value.startsWith("(") ? null : value;
          continue;
        }

        if (line.startsWith("# branch.upstream ")) {
          const value = line.slice("# branch.upstream ".length).trim();
          upstreamRef = value.length > 0 ? value : null;
          continue;
        }

        if (line.startsWith("# branch.ab ")) {
          const value = line.slice("# branch.ab ".length).trim();
          const parsed = parseBranchAb(value);
          aheadCount = parsed.ahead;
          behindCount = parsed.behind;
          continue;
        }

        if (line.trim().length > 0 && !line.startsWith("#")) {
          hasWorkingTreeChanges = true;
          const pathValue = parsePorcelainPath(line);

          if (pathValue) changedFilesWithoutNumstat.add(pathValue);
        }
      }

      const fallbackAheadCount =
        !upstreamRef && refName
          ? yield* computeAheadCountAgainstBase(cwd, refName).pipe(Effect.orElseSucceed(() => 0))
          : null;

      if (fallbackAheadCount !== null) {
        aheadCount = fallbackAheadCount;
        behindCount = 0;
      }

      const isDefaultBranch =
        refName !== null &&
        (refName === defaultBranch ||
          (defaultBranch === null && (refName === "main" || refName === "master")));

      if (refName && !isDefaultBranch) {
        aheadOfDefaultCount =
          fallbackAheadCount !== null
            ? fallbackAheadCount
            : yield* computeAheadCountAgainstBase(cwd, refName).pipe(Effect.orElseSucceed(() => 0));
      }

      const numstatEntries = parseNumstatEntries(numstatStdout);
      const fileStatMap = new Map<string, { insertions: number; deletions: number }>();

      for (const entry of numstatEntries) {
        fileStatMap.set(entry.path, { insertions: entry.insertions, deletions: entry.deletions });
      }

      let insertions = 0;
      let deletions = 0;

      const files = Array.from(fileStatMap.entries())
        .map(([filePath, stat]) => {
          insertions += stat.insertions;
          deletions += stat.deletions;

          return { path: filePath, insertions: stat.insertions, deletions: stat.deletions };
        })
        .toSorted((a, b) => a.path.localeCompare(b.path));

      for (const filePath of changedFilesWithoutNumstat) {
        if (fileStatMap.has(filePath)) continue;
        files.push({ path: filePath, insertions: 0, deletions: 0 });
      }

      files.sort((a, b) => a.path.localeCompare(b.path));

      return {
        isRepo: true,
        hasOriginRemote: hasPrimaryRemote,
        isDefaultBranch,
        branch: refName,
        upstreamRef,
        hasWorkingTreeChanges,
        workingTree: {
          files,
          insertions,
          deletions,
        },
        hasUpstream: upstreamRef !== null,
        aheadCount,
        behindCount,
        aheadOfDefaultCount,
      };
    });

    const statusDetailsLocal: GitVcsDriver.GitVcsDriver["Service"]["statusDetailsLocal"] =
      Effect.fn("statusDetailsLocal")(function* (cwd) {
        return yield* readStatusDetailsLocal(cwd);
      });

    const statusDetails: GitVcsDriver.GitVcsDriver["Service"]["statusDetails"] = Effect.fn(
      "statusDetails",
    )(function* (cwd) {
      yield* refreshStatusUpstreamIfStale(cwd).pipe(
        Effect.catchTags({
          GitCommandError: (error) =>
            isMissingGitCwdError(error) ? Effect.void : Effect.fail(error),
        }),
        Effect.ignoreCause({ log: true }),
      );

      return yield* readStatusDetailsLocal(cwd);
    });

    const statusDetailsRemote: GitVcsDriver.GitVcsDriver["Service"]["statusDetailsRemote"] =
      Effect.fn("statusDetailsRemote")(function* (cwd, options) {
        if (options?.refreshUpstream !== false) {
          yield* refreshStatusUpstreamIfStale(cwd).pipe(
            Effect.catchTags({
              GitCommandError: (error) =>
                isMissingGitCwdError(error) ? Effect.void : Effect.fail(error),
            }),
            Effect.ignoreCause({ log: true }),
          );
        }

        return yield* readStatusDetailsRemote(cwd);
      });

    const status: GitVcsDriver.GitVcsDriver["Service"]["status"] = (input) =>
      statusDetails(input.cwd).pipe(
        Effect.map((details) => ({
          isRepo: details.isRepo,
          hasPrimaryRemote: details.hasOriginRemote,
          isDefaultRef: details.isDefaultBranch,
          refName: details.branch,
          hasWorkingTreeChanges: details.hasWorkingTreeChanges,
          workingTree: details.workingTree,
          hasUpstream: details.hasUpstream,
          aheadCount: details.aheadCount,
          behindCount: details.behindCount,
          aheadOfDefaultCount: details.aheadOfDefaultCount,
        })),
      );

    return { statusDetailsLocal, statusDetails, statusDetailsRemote, status };
  });

export type GitLocalStatusServices = Effect.Success<ReturnType<typeof makeGitLocalStatus>>;
