import * as Effect from "effect/Effect";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import { gitExecution } from "./GitExecution.ts";
import { gitBranches } from "./GitBranches.ts";
import { gitRepositoryPaths } from "./GitRepositoryPaths.ts";
import { gitRemoteStatus } from "./GitRemoteStatus.ts";
import { gitLocalStatus } from "./GitLocalStatus.ts";
import { gitPull } from "./GitPull.ts";
import { gitWorktrees } from "./GitWorktrees.ts";
import { gitRefs } from "./GitRefs.ts";

export const gitVcsDriverCore = Effect.fn("makeGitVcsDriverCore")(function* () {
  const {
    fileSystem,
    path,
    execute,
    executeGit,
    executeGitWithStableDiagnostics,
    runGit,
    runGitStdout,
  } = yield* gitExecution();

  const { branchExists, resolveAvailableBranchName, resolveCurrentUpstream, fetchRemoteForStatus } =
    yield* gitBranches({ path, executeGit, runGitStdout });

  const {
    repositoryPathsCache,
    repositoryPathsRefreshCache,
    normalizeRepositoryPathsCacheKey,
    resolveRepositoryPaths,
  } = yield* gitRepositoryPaths({
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
  } = yield* gitRemoteStatus({
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

  const { statusDetailsLocal, statusDetails, statusDetailsRemote, status } = yield* gitLocalStatus({
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

  const { pullCurrentBranch } = yield* gitPull({ executeGit, runGitStdout, statusDetails });

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
  } = yield* gitWorktrees({
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

  const { listRefs, withListRefsInvalidation, initRepoWithListRefsInvalidation } = yield* gitRefs({
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
