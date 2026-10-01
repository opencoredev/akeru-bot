import * as Effect from "effect/Effect";
import * as GitVcsDriver from "./GitVcsDriver.ts";
// oxlint-disable-next-line anti-slop-effect/no-service-constructor-imports -- This composition root assembles private Git capabilities for the GitVcsDriver layer.
import { makeGitExecution } from "./GitExecution.ts";
// oxlint-disable-next-line anti-slop-effect/no-service-constructor-imports -- This composition root assembles private Git capabilities for the GitVcsDriver layer.
import { makeGitBranches } from "./GitBranches.ts";
// oxlint-disable-next-line anti-slop-effect/no-service-constructor-imports -- This composition root assembles private Git capabilities for the GitVcsDriver layer.
import { makeGitRepositoryPaths } from "./GitRepositoryPaths.ts";
// oxlint-disable-next-line anti-slop-effect/no-service-constructor-imports -- This composition root assembles private Git capabilities for the GitVcsDriver layer.
import { makeGitRemoteStatus } from "./GitRemoteStatus.ts";
// oxlint-disable-next-line anti-slop-effect/no-service-constructor-imports -- This composition root assembles private Git capabilities for the GitVcsDriver layer.
import { makeGitLocalStatus } from "./GitLocalStatus.ts";
// oxlint-disable-next-line anti-slop-effect/no-service-constructor-imports -- This composition root assembles private Git capabilities for the GitVcsDriver layer.
import { makeGitPull } from "./GitPull.ts";
// oxlint-disable-next-line anti-slop-effect/no-service-constructor-imports -- This composition root assembles private Git capabilities for the GitVcsDriver layer.
import { makeGitWorktrees } from "./GitWorktrees.ts";
// oxlint-disable-next-line anti-slop-effect/no-service-constructor-imports -- This composition root assembles private Git capabilities for the GitVcsDriver layer.
import { makeGitRefs } from "./GitRefs.ts";

export const makeGitVcsDriverCore = Effect.fn("makeGitVcsDriverCore")(function* () {
  const {
    fileSystem,
    path,
    execute,
    executeGit,
    executeGitWithStableDiagnostics,
    runGit,
    runGitStdout,
  } = yield* makeGitExecution();

  const { branchExists, resolveAvailableBranchName, resolveCurrentUpstream, fetchRemoteForStatus } =
    yield* makeGitBranches({ path, executeGit, runGitStdout });

  const {
    repositoryPathsCache,
    repositoryPathsRefreshCache,
    normalizeRepositoryPathsCacheKey,
    resolveRepositoryPaths,
  } = yield* makeGitRepositoryPaths({
    fileSystem,
    path,
    executeGit,
    executeGitWithStableDiagnostics,
  });

  const {
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
  } = yield* makeGitRemoteStatus({
    path,
    executeGit,
    executeGitWithStableDiagnostics,
    runGit,
    runGitStdout,
    branchExists,
    resolveCurrentUpstream,
    fetchRemoteForStatus,
    normalizeRepositoryPathsCacheKey,
    resolveRepositoryPaths,
  });

  const { statusDetailsLocal, statusDetails, statusDetailsRemote, status } =
    yield* makeGitLocalStatus({
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
    });

  const { pullCurrentBranch } = yield* makeGitPull({ executeGit, runGitStdout, statusDetails });

  const {
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
  } = yield* makeGitWorktrees({
    fileSystem,
    path,
    executeGit,
    executeGitWithStableDiagnostics,
    runGit,
    runGitStdout,
    resolveAvailableBranchName,
    remoteExists,
    listRemoteNames,
  });

  const { listRefs, withListRefsInvalidation, initRepoWithListRefsInvalidation } =
    yield* makeGitRefs({
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
    });

  return GitVcsDriver.GitVcsDriver.of({
    execute,
    status,
    statusDetails,
    statusDetailsLocal,
    statusDetailsRemote,
    pullCurrentBranch: (cwd) => withListRefsInvalidation(cwd, pullCurrentBranch(cwd)),
    listRefs,
    createWorktree: (input) => withListRefsInvalidation(input.cwd, createWorktree(input)),
    ensureRemote: (input) => withListRefsInvalidation(input.cwd, ensureRemote(input)),
    resolvePrimaryRemoteName,
    resolveDefaultBranchName,
    fetchRemote: (input) => withListRefsInvalidation(input.cwd, fetchRemote(input)),
    remoteExists,
    resolveRemoteTrackingCommit,
    fetchRemoteTrackingBranch: (input) =>
      withListRefsInvalidation(input.cwd, fetchRemoteTrackingBranch(input)),
    removeWorktree: (input) => withListRefsInvalidation(input.cwd, removeWorktree(input)),
    pruneWorktrees: (input) => withListRefsInvalidation(input.cwd, pruneWorktrees(input)),
    renameBranch: (input) => withListRefsInvalidation(input.cwd, renameBranch(input)),
    createRef: (input) => withListRefsInvalidation(input.cwd, createRef(input)),
    switchRef: (input) => withListRefsInvalidation(input.cwd, switchRef(input)),
    initRepo: initRepoWithListRefsInvalidation,
  });
});

export { splitNullSeparatedGitStdoutPaths } from "./GitCoreHelpers.ts";
