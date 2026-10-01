import { parseGitRemoteVerboseOutput } from "./GitOutput.ts";
import * as Cache from "effect/Cache";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Path from "effect/Path";
import { GitCommandError } from "@akeru/contracts";
import { normalizeGitRemoteUrl } from "@akeru/shared/git";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import { parseRemoteNamesInGitOrder } from "../git/remoteRefs.ts";
import {
  STATUS_UPSTREAM_REFRESH_INTERVAL,
  STATUS_UPSTREAM_REFRESH_CACHE_CAPACITY,
  STATUS_DEFAULT_BRANCH_CACHE_TTL,
  STATUS_ORIGIN_EXISTS_CACHE_TTL,
  DEFAULT_BASE_BRANCH_CANDIDATES,
  NON_REPOSITORY_REMOTE_STATUS_DETAILS,
  StatusRemoteRefreshCacheKey,
  statusUpstreamRefreshFailureCooldown,
  sanitizeRemoteName,
  gitCommandContext,
  parseDefaultBranchFromRemoteHeadRef,
  isMissingGitCwdError,
  isNonRepositoryGitStderr,
  isUnbornHeadStderr,
} from "./GitCoreHelpers.ts";
import type { makeGitExecution } from "./GitExecution.ts";
import type { makeGitBranches } from "./GitBranches.ts";
import type { makeGitRepositoryPaths } from "./GitRepositoryPaths.ts";

export const makeGitRemoteStatus = (dependencies: {
  path: Effect.Success<ReturnType<typeof makeGitExecution>>["path"];
  executeGit: Effect.Success<ReturnType<typeof makeGitExecution>>["executeGit"];
  executeGitWithStableDiagnostics: Effect.Success<
    ReturnType<typeof makeGitExecution>
  >["executeGitWithStableDiagnostics"];
  runGit: Effect.Success<ReturnType<typeof makeGitExecution>>["runGit"];
  runGitStdout: Effect.Success<ReturnType<typeof makeGitExecution>>["runGitStdout"];
  branchExists: Effect.Success<ReturnType<typeof makeGitBranches>>["branchExists"];
  resolveCurrentUpstream: Effect.Success<
    ReturnType<typeof makeGitBranches>
  >["resolveCurrentUpstream"];
  fetchRemoteForStatus: Effect.Success<ReturnType<typeof makeGitBranches>>["fetchRemoteForStatus"];
  normalizeRepositoryPathsCacheKey: Effect.Success<
    ReturnType<typeof makeGitRepositoryPaths>
  >["normalizeRepositoryPathsCacheKey"];
  resolveRepositoryPaths: Effect.Success<
    ReturnType<typeof makeGitRepositoryPaths>
  >["resolveRepositoryPaths"];
}) =>
  Effect.gen(function* () {
    const {
      executeGit,
      executeGitWithStableDiagnostics,
      runGit,
      runGitStdout,
      branchExists,
      resolveCurrentUpstream,
      fetchRemoteForStatus,
      normalizeRepositoryPathsCacheKey,
      resolveRepositoryPaths,
    } = dependencies;

    const defaultBranchCache = yield* Cache.makeWith(
      (gitCommonDir: string) =>
        Effect.gen(function* () {
          const path = yield* Path.Path;

          const fetchCwd =
            path.basename(gitCommonDir) === ".git" ? path.dirname(gitCommonDir) : gitCommonDir;

          return yield* executeGit(
            "GitVcsDriver.statusDetails.defaultBranch",
            fetchCwd,
            ["--git-dir", gitCommonDir, "symbolic-ref", "refs/remotes/origin/HEAD"],
            { allowNonZeroExit: true },
          ).pipe(
            Effect.map((result) => {
              if (result.exitCode !== 0) return null;

              return parseDefaultBranchFromRemoteHeadRef(result.stdout, "origin");
            }),
          );
        }),
      {
        capacity: 2_048,
        timeToLive: Exit.match({
          onSuccess: () => STATUS_DEFAULT_BRANCH_CACHE_TTL,
          onFailure: () => Duration.zero,
        }),
      },
    );

    const originExistsCache = yield* Cache.makeWith(
      (gitCommonDir: string) =>
        Effect.gen(function* () {
          const path = yield* Path.Path;

          const fetchCwd =
            path.basename(gitCommonDir) === ".git" ? path.dirname(gitCommonDir) : gitCommonDir;

          return yield* executeGit(
            "GitVcsDriver.statusDetails.originExists",
            fetchCwd,
            ["--git-dir", gitCommonDir, "remote", "get-url", "origin"],
            { allowNonZeroExit: true },
          ).pipe(Effect.map((result) => result.exitCode === 0));
        }),
      {
        capacity: 2_048,
        timeToLive: Exit.match({
          onSuccess: () => STATUS_ORIGIN_EXISTS_CACHE_TTL,
          onFailure: () => Duration.zero,
        }),
      },
    );

    const invalidateStatusStaticCaches = (cwd: string) =>
      Effect.gen(function* () {
        const repositoryPaths = yield* resolveRepositoryPaths(cwd).pipe(
          Effect.catchTags({ GitCommandError: () => Effect.succeed(null) }),
        );

        const cacheKey = repositoryPaths?.gitCommonDir ?? normalizeRepositoryPathsCacheKey(cwd);
        yield* Cache.invalidate(defaultBranchCache, cacheKey);
        yield* Cache.invalidate(originExistsCache, cacheKey);
      });

    const resolveGitCommonDir = Effect.fn("resolveGitCommonDir")(function* (cwd: string) {
      const repositoryPaths = yield* resolveRepositoryPaths(cwd);

      if (repositoryPaths !== null) {
        return repositoryPaths.gitCommonDir;
      }

      return yield* new GitCommandError({
        ...gitCommandContext({
          operation: "GitVcsDriver.resolveGitCommonDir",
          cwd,
          args: ["rev-parse", "--git-common-dir"],
        }),
        detail: "Cannot resolve a Git common directory outside a repository.",
      });
    });

    const statusRemoteRefreshFailureCounts = new Map<string, number>();

    const statusRemoteRefreshFailureKey = (cacheKey: StatusRemoteRefreshCacheKey) =>
      `${cacheKey.gitCommonDir}\0${cacheKey.remoteName}`;

    const recordStatusRemoteRefreshFailure = (cacheKey: StatusRemoteRefreshCacheKey) => {
      const key = statusRemoteRefreshFailureKey(cacheKey);
      const nextCount = (statusRemoteRefreshFailureCounts.get(key) ?? 0) + 1;
      statusRemoteRefreshFailureCounts.delete(key);
      statusRemoteRefreshFailureCounts.set(key, nextCount);

      if (statusRemoteRefreshFailureCounts.size > STATUS_UPSTREAM_REFRESH_CACHE_CAPACITY) {
        const oldestKey = statusRemoteRefreshFailureCounts.keys().next().value;

        if (oldestKey !== undefined) {
          statusRemoteRefreshFailureCounts.delete(oldestKey);
        }
      }
    };

    const clearStatusRemoteRefreshFailures = (cacheKey: StatusRemoteRefreshCacheKey) => {
      statusRemoteRefreshFailureCounts.delete(statusRemoteRefreshFailureKey(cacheKey));
    };

    const refreshStatusRemoteCacheEntry = Effect.fn("refreshStatusRemoteCacheEntry")(function* (
      cacheKey: StatusRemoteRefreshCacheKey,
    ) {
      return yield* fetchRemoteForStatus(cacheKey.gitCommonDir, cacheKey.remoteName).pipe(
        Effect.tap(() => Effect.sync(() => clearStatusRemoteRefreshFailures(cacheKey))),
        Effect.tapError(() => Effect.sync(() => recordStatusRemoteRefreshFailure(cacheKey))),
        Effect.as(true as const),
      );
    });

    const statusRemoteRefreshCache = yield* Cache.makeWith(refreshStatusRemoteCacheEntry, {
      capacity: STATUS_UPSTREAM_REFRESH_CACHE_CAPACITY,
      // A failed background fetch is intentionally cached and exponentially
      // backed off. Status reads swallow this failure and use the last fetched
      // refs, so repeated thread mounts cannot turn a slow or unavailable remote
      // into a repository-wide Git subprocess storm.
      timeToLive: (exit, cacheKey) =>
        Exit.isSuccess(exit)
          ? STATUS_UPSTREAM_REFRESH_INTERVAL
          : statusUpstreamRefreshFailureCooldown(
              statusRemoteRefreshFailureCounts.get(statusRemoteRefreshFailureKey(cacheKey)) ?? 1,
            ),
    });

    const refreshStatusUpstreamIfStale = Effect.fn("refreshStatusUpstreamIfStale")(function* (
      cwd: string,
    ) {
      const upstream = yield* resolveCurrentUpstream(cwd);

      if (!upstream) return;
      const gitCommonDir = yield* resolveGitCommonDir(cwd);
      yield* Cache.get(
        statusRemoteRefreshCache,
        new StatusRemoteRefreshCacheKey({
          gitCommonDir,
          remoteName: upstream.remoteName,
        }),
      );
    });

    const resolveDefaultBranchName = (
      cwd: string,
      remoteName: string,
    ): Effect.Effect<string | null, GitCommandError> =>
      executeGit(
        "GitVcsDriver.resolveDefaultBranchName",
        cwd,
        ["symbolic-ref", `refs/remotes/${remoteName}/HEAD`],
        { allowNonZeroExit: true },
      ).pipe(
        Effect.map((result) => {
          if (result.exitCode !== 0) {
            return null;
          }

          return parseDefaultBranchFromRemoteHeadRef(result.stdout, remoteName);
        }),
      );

    const remoteBranchExists = (
      cwd: string,
      remoteName: string,
      refName: string,
    ): Effect.Effect<boolean, GitCommandError> =>
      executeGit(
        "GitVcsDriver.remoteBranchExists",
        cwd,
        ["show-ref", "--verify", "--quiet", `refs/remotes/${remoteName}/${refName}`],
        {
          allowNonZeroExit: true,
        },
      ).pipe(Effect.map((result) => result.exitCode === 0));

    const remoteExists: GitVcsDriver.GitVcsDriver["Service"]["remoteExists"] = (input) =>
      executeGit("GitVcsDriver.remoteExists", input.cwd, ["remote", "get-url", input.remoteName], {
        allowNonZeroExit: true,
      }).pipe(Effect.map((result) => result.exitCode === 0));

    const originRemoteExists = (cwd: string): Effect.Effect<boolean, GitCommandError> =>
      remoteExists({ cwd, remoteName: "origin" });

    const listRemoteNames = (cwd: string): Effect.Effect<ReadonlyArray<string>, GitCommandError> =>
      runGitStdout("GitVcsDriver.listRemoteNames", cwd, ["remote"]).pipe(
        Effect.map(parseRemoteNamesInGitOrder),
      );

    const resolvePrimaryRemoteName = Effect.fn("resolvePrimaryRemoteName")(function* (cwd: string) {
      if (yield* originRemoteExists(cwd)) {
        return "origin";
      }

      const remotes = yield* listRemoteNames(cwd);
      const [firstRemote] = remotes;

      if (firstRemote) {
        return firstRemote;
      }

      return yield* new GitCommandError({
        ...gitCommandContext({
          operation: "GitVcsDriver.resolvePrimaryRemoteName",
          cwd,
          args: ["remote"],
        }),
        detail: "No git remote is configured for this repository.",
      });
    });

    const ensureRemote: GitVcsDriver.GitVcsDriver["Service"]["ensureRemote"] = Effect.fn(
      "ensureRemote",
    )(function* (input) {
      const preferredName = sanitizeRemoteName(input.preferredName);
      const normalizedTargetUrl = normalizeGitRemoteUrl(input.url);

      const remoteFetchUrls = yield* runGitStdout(
        "GitVcsDriver.ensureRemote.listRemoteUrls",
        input.cwd,
        ["remote", "-v"],
      ).pipe(
        Effect.map(
          (stdout) =>
            new Map(
              [...parseGitRemoteVerboseOutput(stdout)].flatMap(([name, remote]) =>
                remote.url ? [[name, remote.url] as const] : [],
              ),
            ),
        ),
      );

      for (const [remoteName, remoteUrl] of remoteFetchUrls.entries()) {
        if (normalizeGitRemoteUrl(remoteUrl) === normalizedTargetUrl) {
          return remoteName;
        }
      }

      let remoteName = preferredName;
      let suffix = 1;

      while (remoteFetchUrls.has(remoteName)) {
        remoteName = `${preferredName}-${suffix}`;
        suffix += 1;
      }

      yield* runGit("GitVcsDriver.ensureRemote.add", input.cwd, [
        "remote",
        "add",
        remoteName,
        input.url,
      ]);

      return remoteName;
    });

    const resolveBaseBranchForNoUpstream = Effect.fn("resolveBaseBranchForNoUpstream")(function* (
      cwd: string,
      refName: string,
    ) {
      const configuredBaseBranch = yield* runGitStdout(
        "GitVcsDriver.resolveBaseBranchForNoUpstream.config",
        cwd,
        ["config", "--get", `branch.${refName}.gh-merge-base`],
        true,
      ).pipe(Effect.map((stdout) => stdout.trim()));

      const primaryRemoteName = yield* resolvePrimaryRemoteName(cwd).pipe(
        Effect.orElseSucceed(() => null),
      );

      const defaultBranch =
        primaryRemoteName === null ? null : yield* resolveDefaultBranchName(cwd, primaryRemoteName);

      const candidates = [
        configuredBaseBranch.length > 0 ? configuredBaseBranch : null,
        defaultBranch,
        ...DEFAULT_BASE_BRANCH_CANDIDATES,
      ];

      for (const candidate of candidates) {
        if (!candidate) {
          continue;
        }

        const remotePrefix =
          primaryRemoteName && primaryRemoteName !== "origin" ? `${primaryRemoteName}/` : null;

        const normalizedCandidate = candidate.startsWith("origin/")
          ? candidate.slice("origin/".length)
          : remotePrefix && candidate.startsWith(remotePrefix)
            ? candidate.slice(remotePrefix.length)
            : candidate;

        if (normalizedCandidate.length === 0 || normalizedCandidate === refName) {
          continue;
        }

        if (
          primaryRemoteName &&
          (yield* remoteBranchExists(cwd, primaryRemoteName, normalizedCandidate))
        ) {
          return `${primaryRemoteName}/${normalizedCandidate}`;
        }

        if (yield* branchExists(cwd, normalizedCandidate)) {
          return normalizedCandidate;
        }
      }

      return null;
    });

    const computeAheadCountAgainstBase = Effect.fn("computeAheadCountAgainstBase")(function* (
      cwd: string,
      refName: string,
    ) {
      const baseRef = yield* resolveBaseBranchForNoUpstream(cwd, refName);

      if (!baseRef) {
        return 0;
      }

      const result = yield* executeGit(
        "GitVcsDriver.computeAheadCountAgainstBase",
        cwd,
        ["rev-list", "--count", `${baseRef}..HEAD`],
        { allowNonZeroExit: true },
      );

      if (result.exitCode !== 0) {
        return 0;
      }

      const parsed = Number.parseInt(result.stdout.trim(), 10);

      return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
    });

    const readStatusDetailsRemote = Effect.fn("readStatusDetailsRemote")(function* (cwd: string) {
      const branchResult = yield* executeGitWithStableDiagnostics(
        "GitVcsDriver.statusDetailsRemote.branch",
        cwd,
        ["rev-parse", "--abbrev-ref", "HEAD"],
        { allowNonZeroExit: true },
      ).pipe(
        Effect.catchTags({
          GitCommandError: (error) =>
            isMissingGitCwdError(error) ? Effect.succeed(null) : Effect.fail(error),
        }),
      );

      if (branchResult === null) {
        return NON_REPOSITORY_REMOTE_STATUS_DETAILS;
      }

      let branch: string | null;

      if (branchResult.exitCode !== 0) {
        if (isNonRepositoryGitStderr(branchResult.stderr)) {
          return NON_REPOSITORY_REMOTE_STATUS_DETAILS;
        }

        if (!isUnbornHeadStderr(branchResult.stderr)) {
          return yield* new GitCommandError({
            ...gitCommandContext({
              operation: "GitVcsDriver.statusDetailsRemote.branch",
              cwd,
              args: ["rev-parse", "--abbrev-ref", "HEAD"],
            }),
            detail: "Git branch lookup failed.",
            exitCode: branchResult.exitCode,
            stdoutLength: branchResult.stdout.length,
            stderrLength: branchResult.stderr.length,
          });
        }

        const branchValue = yield* runGitStdout(
          "GitVcsDriver.statusDetailsRemote.unbornBranch",
          cwd,
          ["symbolic-ref", "--quiet", "--short", "HEAD"],
        );

        branch = branchValue.trim() || null;
      } else {
        const branchValue = branchResult.stdout.trim();
        branch = branchValue.length > 0 && branchValue !== "HEAD" ? branchValue : null;
      }

      const upstream = yield* resolveCurrentUpstream(cwd);
      const upstreamRef = upstream?.upstreamRef ?? null;
      let aheadCount = 0;
      let behindCount = 0;

      if (upstreamRef) {
        const divergence = yield* executeGit(
          "GitVcsDriver.statusDetailsRemote.divergence",
          cwd,
          ["rev-list", "--left-right", "--count", `HEAD...${upstreamRef}`],
          { allowNonZeroExit: true },
        );

        if (divergence.exitCode === 0) {
          const [aheadRaw, behindRaw] = divergence.stdout.trim().split(/\s+/);
          const parsedAhead = Number.parseInt(aheadRaw ?? "0", 10);
          const parsedBehind = Number.parseInt(behindRaw ?? "0", 10);
          aheadCount = Number.isFinite(parsedAhead) ? Math.max(0, parsedAhead) : 0;
          behindCount = Number.isFinite(parsedBehind) ? Math.max(0, parsedBehind) : 0;
        }
      } else if (branch) {
        aheadCount = yield* computeAheadCountAgainstBase(cwd, branch).pipe(
          Effect.orElseSucceed(() => 0),
        );
      }

      const defaultBranch = yield* resolveDefaultBranchName(cwd, "origin");

      const isDefaultBranch =
        branch !== null &&
        (branch === defaultBranch ||
          (defaultBranch === null && (branch === "main" || branch === "master")));

      const aheadOfDefaultCount =
        branch && !isDefaultBranch
          ? upstreamRef === null
            ? aheadCount
            : yield* computeAheadCountAgainstBase(cwd, branch).pipe(Effect.orElseSucceed(() => 0))
          : 0;

      return {
        isRepo: true,
        defaultBranch,
        isDefaultBranch,
        branch,
        upstreamRef,
        hasUpstream: upstreamRef !== null,
        aheadCount,
        behindCount,
        aheadOfDefaultCount,
      };
    });

    return {
      defaultBranchCache,
      originExistsCache,
      invalidateStatusStaticCaches,
      refreshStatusUpstreamIfStale,
      resolveDefaultBranchName,
      remoteExists,
      originRemoteExists,
      listRemoteNames,
      resolvePrimaryRemoteName,
      ensureRemote,
      computeAheadCountAgainstBase,
      readStatusDetailsRemote,
    };
  });
