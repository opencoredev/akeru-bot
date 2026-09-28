import { useMemo } from "react";

import { useSelectedThreadDetail } from "./use-thread-detail";
import { useThreadSelection } from "./use-thread-selection";

/** The detail snapshot's worktree is fresher than the shell's when both exist. */
export function resolvePreferredThreadWorktreePath(input: {
  readonly threadShellWorktreePath: string | null;
  readonly threadDetailWorktreePath: string | null;
}): string | null {
  return input.threadDetailWorktreePath ?? input.threadShellWorktreePath ?? null;
}

export function useSelectedThreadWorktree() {
  const { selectedThread, selectedThreadProject } = useThreadSelection();
  const selectedThreadDetail = useSelectedThreadDetail();

  const selectedThreadWorktreePath = useMemo(
    () =>
      resolvePreferredThreadWorktreePath({
        threadShellWorktreePath: selectedThread?.worktreePath ?? null,
        threadDetailWorktreePath: selectedThreadDetail?.worktreePath ?? null,
      }),
    [selectedThread?.worktreePath, selectedThreadDetail?.worktreePath],
  );

  return {
    selectedThreadWorktreePath,
    selectedThreadCwd: selectedThreadWorktreePath ?? selectedThreadProject?.workspaceRoot ?? null,
  };
}
