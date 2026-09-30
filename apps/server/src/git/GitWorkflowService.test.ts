import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { VcsRepositoryDetectionError } from "@akeru/contracts";

import * as GitWorkflowService from "./GitWorkflowService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";

function makeLayer(input: {
  readonly resolve: VcsDriverRegistry.VcsDriverRegistry["Service"]["resolve"];
}) {
  return GitWorkflowService.layer.pipe(
    Layer.provide(
      Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
        resolve: input.resolve,
      }),
    ),
    Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
  );
}

describe("GitWorkflowService", () => {
  const cause = new VcsRepositoryDetectionError({
    operation: "VcsDriverRegistry.resolve",
    cwd: "/repo",
    detail: "upstream detail must stay in the cause chain",
  });

  it.effect("structures worktree command failures without exposing upstream details", () =>
    Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const error = yield* workflow
        .createWorktree({ cwd: "/repo", refName: "main", path: null })
        .pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "GitCommandError",
        operation: "GitWorkflowService.createWorktree",
        command: "vcs-route",
        cwd: "/repo",
        detail: "Failed to resolve the VCS driver for this Git command.",
      });
      expect(error.message).not.toContain(cause.detail);
    }).pipe(Effect.provide(makeLayer({ resolve: () => Effect.fail(cause) }))),
  );

  it.effect("structures branch rename failures without exposing upstream details", () =>
    Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const error = yield* workflow
        .renameBranch({ cwd: "/repo", oldBranch: "akeru/tmp", newBranch: "akeru/named" })
        .pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "GitManagerError",
        operation: "GitWorkflowService.renameBranch",
        cwd: "/repo",
        detail: "Failed to resolve the VCS driver for this Git workflow.",
      });
      expect(error.message).not.toContain(cause.detail);
    }).pipe(Effect.provide(makeLayer({ resolve: () => Effect.fail(cause) }))),
  );
});
