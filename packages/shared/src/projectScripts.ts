import type { ProjectScript } from "@akeru/contracts";

interface ProjectScriptRuntimeEnvInput {
  project: {
    cwd: string;
  };
  worktreePath?: string | null;
  extraEnv?: Record<string, string>;
}

export function projectScriptCwd(input: {
  project: {
    cwd: string;
  };
  worktreePath?: string | null;
}): string {
  return input.worktreePath ?? input.project.cwd;
}

export function projectScriptRuntimeEnv(input: ProjectScriptRuntimeEnvInput) {
  return {
    T3CODE_PROJECT_ROOT: input.project.cwd,
    ...(input.worktreePath ? { T3CODE_WORKTREE_PATH: input.worktreePath } : {}),
    ...input.extraEnv,
  };
}

export function setupProjectScript(scripts: readonly ProjectScript[]): ProjectScript | null {
  return scripts.find((script) => script.runOnWorktreeCreate) ?? null;
}
