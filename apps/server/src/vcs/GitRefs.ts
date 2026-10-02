import * as Match from "effect/Match";
import * as Cache from "effect/Cache";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { type VcsRef } from "@akeru/contracts";
import { dedupeRemoteBranchesWithLocalMatches } from "@akeru/shared/git";
import type * as GitVcsDriver from "./GitVcsDriver.ts";
import { parseRemoteNames, parseRemoteRefWithRemoteNames } from "../git/remoteRefs.ts";
import {
  LIST_REFS_SNAPSHOT_CACHE_CAPACITY,
  LIST_REFS_SNAPSHOT_CACHE_TTL,
  LIST_REFS_REFRESH_COALESCE_TTL,
  LIST_REFS_REFRESH_FAILURE_COOLDOWN,
  GitRefsSnapshotCacheKey,
  GitRefsRefreshCacheKey,
  type GitRefsSnapshot,
  filterBranchesForListQuery,
  paginateBranches,
  parseWorktreeBranchPaths,
  isMissingGitCwdError,
} from "./GitCoreHelpers.ts";
import type { GitExecutionServices } from "./GitExecution.ts";
import type { GitRepositoryPathsServices } from "./GitRepositoryPaths.ts";
import type { GitRemoteStatusServices } from "./GitRemoteStatus.ts";
import type { GitWorktreesServices } from "./GitWorktrees.ts";

export const gitRefs = (dependencies: {
  fileSystem: GitExecutionServices["fileSystem"];
  path: GitExecutionServices["path"];
  executeGit: GitExecutionServices["executeGit"];
  executeGitWithStableDiagnostics: GitExecutionServices["executeGitWithStableDiagnostics"];
  repositoryPathsCache: GitRepositoryPathsServices["repositoryPathsCache"];
  repositoryPathsRefreshCache: GitRepositoryPathsServices["repositoryPathsRefreshCache"];
  normalizeRepositoryPathsCacheKey: GitRepositoryPathsServices["normalizeRepositoryPathsCacheKey"];
  resolveRepositoryPaths: GitRepositoryPathsServices["resolveRepositoryPaths"];
  invalidateStatusStaticCaches: GitRemoteStatusServices["invalidateStatusStaticCaches"];
  initRepo: GitWorktreesServices["initRepo"];
}) =>
  Effect.gen(function* () {
    const {
      fileSystem,
      path,
      executeGit,
      executeGitWithStableDiagnostics,
      repositoryPathsCache,
      repositoryPathsRefreshCache,
      normalizeRepositoryPathsCacheKey,
      resolveRepositoryPaths,
      invalidateStatusStaticCaches,
      initRepo,
    } = dependencies;

    const readGitRefsSnapshot = Effect.fn("readGitRefsSnapshot")(function* (gitCommonDir: string) {
      const fetchCwd =
        path.basename(gitCommonDir) === ".git" ? path.dirname(gitCommonDir) : gitCommonDir;

      const gitDirArgs = ["--git-dir", gitCommonDir] as const;

      const [refsResult, defaultRefResult, worktreeListResult, remoteNamesResult] =
        yield* Effect.all(
          [
            executeGitWithStableDiagnostics(
              "GitVcsDriver.listRefs.snapshotRefs",
              fetchCwd,
              [
                ...gitDirArgs,
                "for-each-ref",
                "--format=%(refname)%09%(committerdate:unix)%09%(symref)",
                "refs/heads",
                "refs/remotes",
              ],
              {
                timeoutMs: 30_000,
                maxOutputBytes: 16 * 1024 * 1024,
                fallbackErrorDetail: "Git ref snapshot enumeration failed.",
              },
            ),
            executeGit(
              "GitVcsDriver.listRefs.defaultRef",
              fetchCwd,
              [...gitDirArgs, "symbolic-ref", "refs/remotes/origin/HEAD"],
              {
                timeoutMs: 5_000,
                allowNonZeroExit: true,
              },
            ),
            executeGit(
              "GitVcsDriver.listRefs.worktreeList",
              fetchCwd,
              [...gitDirArgs, "worktree", "list", "--porcelain", "-z"],
              {
                timeoutMs: 30_000,
                allowNonZeroExit: true,
                maxOutputBytes: 16 * 1024 * 1024,
              },
            ),
            executeGit("GitVcsDriver.listRefs.remoteNames", fetchCwd, [...gitDirArgs, "remote"], {
              timeoutMs: 5_000,
              allowNonZeroExit: true,
            }),
          ],
          { concurrency: 2 },
        );

      const remoteNames =
        remoteNamesResult.exitCode === 0 ? parseRemoteNames(remoteNamesResult.stdout) : [];

      if (remoteNamesResult.exitCode !== 0 && remoteNamesResult.stderr.trim().length > 0) {
        yield* Effect.logWarning(
          `GitVcsDriver.listRefs: remote name lookup returned code ${remoteNamesResult.exitCode} for ${gitCommonDir}: ${remoteNamesResult.stderr.trim()}. Falling back to an empty remote name list.`,
        );
      }

      const defaultBranch =
        defaultRefResult.exitCode === 0
          ? defaultRefResult.stdout.trim().replace(/^refs\/remotes\/origin\//, "")
          : null;

      const parsedWorktreeEntries =
        worktreeListResult.exitCode === 0
          ? [...parseWorktreeBranchPaths(worktreeListResult.stdout)].map(
              ([branchName, worktreePath]) =>
                [branchName, path.normalize(path.resolve(worktreePath))] as const,
            )
          : [];

      const existingWorktreeEntries = yield* Effect.filter(
        parsedWorktreeEntries,
        ([, worktreePath]) =>
          fileSystem.stat(worktreePath).pipe(
            Effect.as(true),
            Effect.orElseSucceed(() => false),
          ),
        { concurrency: 16 },
      );

      const worktreeMap = new Map(existingWorktreeEntries);
      const localBranches: Array<{ readonly ref: VcsRef; readonly lastCommit: number }> = [];
      const remoteBranches: Array<{ readonly ref: VcsRef; readonly lastCommit: number }> = [];

      for (const line of refsResult.stdout.split("\n")) {
        if (line.length === 0) continue;
        const [fullRefName, lastCommitRaw, symbolicTarget] = line.split("\t");

        if (!fullRefName || symbolicTarget) continue;
        const parsedLastCommit = Number.parseInt(lastCommitRaw ?? "0", 10);
        const lastCommit = Number.isFinite(parsedLastCommit) ? parsedLastCommit : 0;

        if (fullRefName.startsWith("refs/heads/")) {
          const name = fullRefName.slice("refs/heads/".length);
          localBranches.push({
            ref: {
              name,
              current: false,
              isRemote: false,
              isDefault: name === defaultBranch,
              worktreePath: worktreeMap.get(name) ?? null,
            },
            lastCommit,
          });
          continue;
        }

        if (!fullRefName.startsWith("refs/remotes/")) continue;

        const name = fullRefName.slice("refs/remotes/".length);
        const parsedRemoteRef = parseRemoteRefWithRemoteNames(name, remoteNames);

        const remoteBranch: VcsRef = {
          name,
          current: false,
          isRemote: true,
          isDefault:
            defaultBranch !== null &&
            parsedRemoteRef?.remoteName === "origin" &&
            parsedRemoteRef.branchName === defaultBranch,
          worktreePath: null,
          ...(parsedRemoteRef ? { remoteName: parsedRemoteRef.remoteName } : {}),
        };

        remoteBranches.push({ ref: remoteBranch, lastCommit });
      }

      const byRecencyThenName = (
        left: { readonly ref: VcsRef; readonly lastCommit: number },
        right: { readonly ref: VcsRef; readonly lastCommit: number },
      ) =>
        left.lastCommit !== right.lastCommit
          ? right.lastCommit - left.lastCommit
          : left.ref.name.localeCompare(right.ref.name);

      return {
        localBranches: localBranches.toSorted(byRecencyThenName).map(({ ref }) => ref),
        remoteBranches: remoteBranches.toSorted(byRecencyThenName).map(({ ref }) => ref),
        hasPrimaryRemote: remoteNames.includes("origin"),
      } satisfies GitRefsSnapshot;
    });

    const listRefsEpochByCommonDir = new Map<string, number>();

    let listRefsEpochSequence = 0;

    const bumpListRefsEpoch = (gitCommonDir: string): number => {
      const nextEpoch = ++listRefsEpochSequence;
      listRefsEpochByCommonDir.delete(gitCommonDir);
      listRefsEpochByCommonDir.set(gitCommonDir, nextEpoch);

      if (listRefsEpochByCommonDir.size > LIST_REFS_SNAPSHOT_CACHE_CAPACITY) {
        const oldestKey = listRefsEpochByCommonDir.keys().next().value;

        if (oldestKey !== undefined) {
          listRefsEpochByCommonDir.delete(oldestKey);
        }
      }

      return nextEpoch;
    };

    const listRefsGenerationByCommonDir = new Map<string, number>();

    let listRefsGenerationSequence = 0;

    const setListRefsGeneration = (gitCommonDir: string, generation: number): number => {
      listRefsGenerationByCommonDir.delete(gitCommonDir);
      listRefsGenerationByCommonDir.set(gitCommonDir, generation);

      if (listRefsGenerationByCommonDir.size > LIST_REFS_SNAPSHOT_CACHE_CAPACITY) {
        const oldestKey = listRefsGenerationByCommonDir.keys().next().value;

        if (oldestKey !== undefined) {
          listRefsGenerationByCommonDir.delete(oldestKey);
        }
      }

      return generation;
    };

    const currentListRefsGeneration = (gitCommonDir: string): number => {
      const current = listRefsGenerationByCommonDir.get(gitCommonDir);

      return current === undefined
        ? setListRefsGeneration(gitCommonDir, ++listRefsGenerationSequence)
        : setListRefsGeneration(gitCommonDir, current);
    };

    const bumpListRefsGeneration = (gitCommonDir: string): number =>
      setListRefsGeneration(gitCommonDir, ++listRefsGenerationSequence);

    const listRefsSnapshotCache = yield* Cache.makeWith(
      (cacheKey: GitRefsSnapshotCacheKey) => readGitRefsSnapshot(cacheKey.gitCommonDir),
      {
        capacity: LIST_REFS_SNAPSHOT_CACHE_CAPACITY,
        timeToLive: (exit) => (Exit.isSuccess(exit) ? LIST_REFS_SNAPSHOT_CACHE_TTL : Duration.zero),
      },
    );

    const listRefsRefreshSnapshotCache = yield* Cache.makeWith(
      (cacheKey: GitRefsRefreshCacheKey) =>
        Effect.suspend(() => {
          const epoch = bumpListRefsEpoch(cacheKey.gitCommonDir);

          return Cache.get(
            listRefsSnapshotCache,
            new GitRefsSnapshotCacheKey({ gitCommonDir: cacheKey.gitCommonDir, epoch }),
          );
        }),
      {
        capacity: LIST_REFS_SNAPSHOT_CACHE_CAPACITY,
        timeToLive: (exit) =>
          Exit.isSuccess(exit)
            ? LIST_REFS_REFRESH_COALESCE_TTL
            : LIST_REFS_REFRESH_FAILURE_COOLDOWN,
      },
    );

    const resolveListRefsSnapshot = Effect.fn("resolveListRefsSnapshot")(function* (
      gitCommonDir: string,
      refresh: boolean,
    ) {
      while (true) {
        const generation = currentListRefsGeneration(gitCommonDir);
        const currentEpoch = listRefsEpochByCommonDir.get(gitCommonDir);

        const snapshot =
          refresh || currentEpoch === undefined
            ? // The refresh cache owns the complete snapshot read, rather than only the
              // epoch bump. Slow repositories therefore remain singleflight for the
              // entire Git scan even when more refresh requests arrive after the
              // coalescing TTL would otherwise have elapsed.
              yield* Cache.get(
                listRefsRefreshSnapshotCache,
                new GitRefsRefreshCacheKey({ gitCommonDir, generation }),
              )
            : yield* Cache.get(
                listRefsSnapshotCache,
                new GitRefsSnapshotCacheKey({ gitCommonDir, epoch: currentEpoch }),
              );

        if (currentListRefsGeneration(gitCommonDir) === generation) {
          return snapshot;
        }
      }
    });

    const invalidateListRefsSnapshot = Effect.fn("invalidateListRefsSnapshot")(function* (
      cwd: string,
    ) {
      const repositoryPathsCacheKey = normalizeRepositoryPathsCacheKey(cwd);
      const repositoryPaths = yield* Cache.get(repositoryPathsCache, repositoryPathsCacheKey);

      if (repositoryPaths === null) return;
      const previousGeneration = currentListRefsGeneration(repositoryPaths.gitCommonDir);
      bumpListRefsGeneration(repositoryPaths.gitCommonDir);
      bumpListRefsEpoch(repositoryPaths.gitCommonDir);
      yield* Cache.invalidate(
        listRefsRefreshSnapshotCache,
        new GitRefsRefreshCacheKey({
          gitCommonDir: repositoryPaths.gitCommonDir,
          generation: previousGeneration,
        }),
      );
      yield* Cache.invalidate(repositoryPathsRefreshCache, repositoryPathsCacheKey);
      yield* Cache.invalidate(repositoryPathsCache, repositoryPathsCacheKey);
    });

    const listRefs: GitVcsDriver.GitVcsDriver["Service"]["listRefs"] = Effect.fn("listRefs")(
      function* (input) {
        const repositoryPaths = yield* resolveRepositoryPaths(
          input.cwd,
          input.refresh === true,
        ).pipe(
          Effect.catchTags({
            GitCommandError: (error) =>
              isMissingGitCwdError(error) ? Effect.succeed(null) : Effect.fail(error),
          }),
        );

        if (repositoryPaths === null) {
          return {
            refs: [],
            isRepo: false,
            hasPrimaryRemote: false,
            nextCursor: null,
            totalCount: 0,
          };
        }

        const snapshot = yield* resolveListRefsSnapshot(
          repositoryPaths.gitCommonDir,
          input.refresh === true,
        );

        const hasCurrentWorktreeBranch =
          repositoryPaths.worktreeRoot !== null &&
          snapshot.localBranches.some((ref) => ref.worktreePath === repositoryPaths.worktreeRoot);

        const localBranches = snapshot.localBranches.map((ref) => ({
          ...ref,
          current: hasCurrentWorktreeBranch
            ? ref.worktreePath === repositoryPaths.worktreeRoot
            : ref.name === repositoryPaths.currentBranch,
        }));

        const combinedBranches = input.includeMatchingRemoteRefs
          ? [...localBranches, ...snapshot.remoteBranches]
          : dedupeRemoteBranchesWithLocalMatches([...localBranches, ...snapshot.remoteBranches]);

        // Keep current/default refs on the first page even when the default
        // only exists as origin/<default> (remote refs sort after all locals).
        const allBranches = combinedBranches.toSorted((left, right) => {
          const leftPriority = left.current ? 0 : left.isDefault ? 1 : 2;
          const rightPriority = right.current ? 0 : right.isDefault ? 1 : 2;

          return leftPriority - rightPriority;
        });

        const branchesForKind = Match.value(input.refKind).pipe(
          Match.when("local", () => allBranches.filter((ref) => !ref.isRemote)),
          Match.when("remote", () => allBranches.filter((ref) => ref.isRemote)),
          Match.orElse(() => allBranches),
        );

        const refs = paginateBranches({
          refs: filterBranchesForListQuery(branchesForKind, input.query),
          cursor: input.cursor,
          limit: input.limit,
        });

        return {
          refs: [...refs.refs],
          isRepo: true,
          hasPrimaryRemote: snapshot.hasPrimaryRemote,
          nextCursor: refs.nextCursor,
          totalCount: refs.totalCount,
        };
      },
    );

    const withListRefsInvalidation = <A, E>(
      cwd: string,
      effect: Effect.Effect<A, E>,
    ): Effect.Effect<A, E> =>
      effect.pipe(
        Effect.ensuring(
          Effect.all([
            invalidateListRefsSnapshot(cwd).pipe(Effect.ignore),
            invalidateStatusStaticCaches(cwd).pipe(Effect.ignore),
          ]),
        ),
      );

    const initRepoWithListRefsInvalidation: GitVcsDriver.GitVcsDriver["Service"]["initRepo"] = (
      input,
    ) =>
      initRepo(input).pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            const cacheKey = normalizeRepositoryPathsCacheKey(input.cwd);
            yield* Cache.invalidate(repositoryPathsRefreshCache, cacheKey);
            yield* Cache.invalidate(repositoryPathsCache, cacheKey);
            yield* invalidateListRefsSnapshot(input.cwd).pipe(Effect.ignore);
          }),
        ),
      );

    return { listRefs, withListRefsInvalidation, initRepoWithListRefsInvalidation };
  });
