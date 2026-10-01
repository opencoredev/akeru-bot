import * as Effect from "effect/Effect";
import { GitCommandError } from "@akeru/contracts";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import { gitCommandContext } from "./GitCoreHelpers.ts";
import type { makeGitExecution } from "./GitExecution.ts";
import type { makeGitLocalStatus } from "./GitLocalStatus.ts";

export const makeGitPull = (dependencies: {
  executeGit: Effect.Success<ReturnType<typeof makeGitExecution>>["executeGit"];
  runGitStdout: Effect.Success<ReturnType<typeof makeGitExecution>>["runGitStdout"];
  statusDetails: Effect.Success<ReturnType<typeof makeGitLocalStatus>>["statusDetails"];
}) =>
  Effect.gen(function* () {
    const { executeGit, runGitStdout, statusDetails } = dependencies;

    const pullCurrentBranch: GitVcsDriver.GitVcsDriver["Service"]["pullCurrentBranch"] = Effect.fn(
      "pullCurrentBranch",
    )(function* (cwd) {
      const details = yield* statusDetails(cwd);
      const refName = details.branch;

      if (!refName) {
        return yield* new GitCommandError({
          ...gitCommandContext({
            operation: "GitVcsDriver.pullCurrentBranch",
            cwd,
            args: ["pull", "--ff-only"],
          }),
          detail: "Cannot pull from detached HEAD.",
        });
      }

      if (!details.hasUpstream) {
        return yield* new GitCommandError({
          ...gitCommandContext({
            operation: "GitVcsDriver.pullCurrentBranch",
            cwd,
            args: ["pull", "--ff-only"],
          }),
          detail: "Current branch has no upstream configured. Push with upstream first.",
        });
      }

      const beforeSha = yield* runGitStdout(
        "GitVcsDriver.pullCurrentBranch.beforeSha",
        cwd,
        ["rev-parse", "HEAD"],
        true,
      ).pipe(Effect.map((stdout) => stdout.trim()));

      yield* executeGit("GitVcsDriver.pullCurrentBranch.pull", cwd, ["pull", "--ff-only"], {
        timeoutMs: 30_000,
        fallbackErrorDetail: "git pull failed",
      });

      const afterSha = yield* runGitStdout(
        "GitVcsDriver.pullCurrentBranch.afterSha",
        cwd,
        ["rev-parse", "HEAD"],
        true,
      ).pipe(Effect.map((stdout) => stdout.trim()));

      const refreshed = yield* statusDetails(cwd);

      return {
        status: beforeSha.length > 0 && beforeSha === afterSha ? "skipped_up_to_date" : "pulled",
        refName,
        upstreamRef: refreshed.upstreamRef,
      };
    });

    return { pullCurrentBranch };
  });
