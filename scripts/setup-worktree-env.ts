// @effect-diagnostics nodeBuiltinImport:off - worktree setup runs before the application runtime.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

/** Copies initial configuration without sharing later edits with the source checkout. */
export function setupWorktreeEnv(worktree: string, projectRoot: string | undefined) {
  const destination = NodePath.join(worktree, ".env");
  try {
    const existing = NodeFS.lstatSync(destination);
    if (existing.isSymbolicLink()) {
      throw new Error(
        "Worktree .env is a symlink. Replace it with a private copy before editing it.",
      );
    }
    if (!existing.isFile()) throw new Error("Worktree .env is not a regular file.");
    return "Kept the existing worktree .env.";
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  if (!projectRoot?.trim()) return "No project root supplied; skipped optional .env copy.";
  const source = NodePath.join(NodePath.resolve(projectRoot), ".env");
  if (!NodeFS.existsSync(source)) return "Project has no .env; skipped optional .env copy.";
  NodeFS.copyFileSync(source, destination, NodeFS.constants.COPYFILE_EXCL);
  NodeFS.chmodSync(destination, 0o600);
  return "Copied .env into the worktree; future edits stay local.";
}

if (
  process.argv[1] &&
  NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url)
) {
  process.stdout.write(
    `[setup-worktree] ${setupWorktreeEnv(process.cwd(), process.env.T3CODE_PROJECT_ROOT)}\n`,
  );
}
