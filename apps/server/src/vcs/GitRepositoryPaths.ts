import * as Cache from "effect/Cache";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { GitCommandError } from "@akeru/contracts";
import {
  REPOSITORY_PATHS_CACHE_CAPACITY,
  REPOSITORY_PATHS_CACHE_TTL,
  REPOSITORY_PATHS_REFRESH_COALESCE_TTL,
  NON_REPOSITORY_PATHS_CACHE_TTL,
  type GitRepositoryPaths,
  gitCommandContext,
  isNonRepositoryGitStderr,
} from "./GitCoreHelpers.ts";
import type { GitExecutionServices } from "./GitExecution.ts";

export const makeGitRepositoryPaths = (dependencies: {
  fileSystem: GitExecutionServices["fileSystem"];
  path: GitExecutionServices["path"];
  executeGit: GitExecutionServices["executeGit"];
  executeGitWithStableDiagnostics: GitExecutionServices["executeGitWithStableDiagnostics"];
}) =>
  Effect.gen(function* () {
    const { fileSystem, path, executeGit, executeGitWithStableDiagnostics } = dependencies;

    const resolveRepositoryPathsUncached = Effect.fn("resolveRepositoryPathsUncached")(function* (
      cwd: string,
    ) {
      const commonDirResult = yield* executeGitWithStableDiagnostics(
        "GitVcsDriver.resolveRepositoryPaths.commonDir",
        cwd,
        ["rev-parse", "--git-common-dir"],
        {
          timeoutMs: 5_000,
          allowNonZeroExit: true,
        },
      );

      if (commonDirResult.exitCode !== 0) {
        const stderr = commonDirResult.stderr.trim();

        if (isNonRepositoryGitStderr(stderr)) {
          return null;
        }

        return yield* new GitCommandError({
          ...gitCommandContext({
            operation: "GitVcsDriver.resolveRepositoryPaths.commonDir",
            cwd,
            args: ["rev-parse", "--git-common-dir"],
          }),
          detail: "Failed to resolve the Git common directory.",
          exitCode: commonDirResult.exitCode,
          stdoutLength: commonDirResult.stdout.length,
          stderrLength: commonDirResult.stderr.length,
        });
      }

      const commonDirOutput = commonDirResult.stdout.trim();

      const resolvedGitCommonDir = path.isAbsolute(commonDirOutput)
        ? path.normalize(commonDirOutput)
        : path.resolve(cwd, commonDirOutput);

      const gitCommonDir = yield* fileSystem
        .realPath(resolvedGitCommonDir)
        .pipe(Effect.orElseSucceed(() => resolvedGitCommonDir));

      const [worktreeRootResult, currentBranchResult] = yield* Effect.all(
        [
          executeGit(
            "GitVcsDriver.resolveRepositoryPaths.worktreeRoot",
            cwd,
            ["rev-parse", "--show-toplevel"],
            {
              timeoutMs: 5_000,
              allowNonZeroExit: true,
            },
          ),
          executeGit(
            "GitVcsDriver.resolveRepositoryPaths.currentBranch",
            cwd,
            ["symbolic-ref", "--quiet", "--short", "HEAD"],
            {
              timeoutMs: 5_000,
              allowNonZeroExit: true,
            },
          ),
        ],
        { concurrency: 2 },
      );

      const worktreeRootOutput = worktreeRootResult.stdout.trim();

      const worktreeRoot =
        worktreeRootResult.exitCode === 0 && worktreeRootOutput.length > 0
          ? path.normalize(
              path.isAbsolute(worktreeRootOutput)
                ? worktreeRootOutput
                : path.resolve(cwd, worktreeRootOutput),
            )
          : null;

      const currentBranchOutput = currentBranchResult.stdout.trim();

      const currentBranch =
        currentBranchResult.exitCode === 0 && currentBranchOutput.length > 0
          ? currentBranchOutput
          : null;

      return {
        gitCommonDir,
        worktreeRoot,
        currentBranch,
      } satisfies GitRepositoryPaths;
    });

    const repositoryPathsCache = yield* Cache.makeWith(
      (cwd: string) => resolveRepositoryPathsUncached(cwd),
      {
        capacity: REPOSITORY_PATHS_CACHE_CAPACITY,
        timeToLive: Exit.match({
          onSuccess: (repositoryPaths) =>
            repositoryPaths === null ? NON_REPOSITORY_PATHS_CACHE_TTL : REPOSITORY_PATHS_CACHE_TTL,
          onFailure: () => Duration.zero,
        }),
      },
    );

    const repositoryPathsRefreshCache = yield* Cache.makeWith(
      (cwd: string) =>
        Cache.invalidate(repositoryPathsCache, cwd).pipe(
          Effect.andThen(Cache.get(repositoryPathsCache, cwd)),
        ),
      {
        capacity: REPOSITORY_PATHS_CACHE_CAPACITY,
        timeToLive: Exit.match({
          onSuccess: (repositoryPaths) =>
            repositoryPaths === null
              ? NON_REPOSITORY_PATHS_CACHE_TTL
              : REPOSITORY_PATHS_REFRESH_COALESCE_TTL,
          onFailure: () => Duration.zero,
        }),
      },
    );

    const normalizeRepositoryPathsCacheKey = (cwd: string) => path.normalize(path.resolve(cwd));

    const resolveRepositoryPaths = (cwd: string, refresh = false) => {
      const cacheKey = normalizeRepositoryPathsCacheKey(cwd);

      return Cache.get(refresh ? repositoryPathsRefreshCache : repositoryPathsCache, cacheKey);
    };

    return {
      repositoryPathsCache,
      repositoryPathsRefreshCache,
      normalizeRepositoryPathsCacheKey,
      resolveRepositoryPaths,
    };
  });

export type GitRepositoryPathsServices = Effect.Success<ReturnType<typeof makeGitRepositoryPaths>>;
