/**
 * The home folder a Claude Code process runs with, resolved once for both its
 * environment and the paths its session protects.
 *
 * @module provider/Layers/claude/ClaudeChildHome
 */
import * as NodeOS from "node:os";

/**
 * Where Claude Code finds `.claude` and `.claude.json`: Node's `os.homedir()`
 * reads USERPROFILE on Windows and HOME elsewhere, so the child's value of
 * that variable decides, else the server's own home. Windows variable names
 * are case-insensitive; when several spellings are set, Node's spawn keeps the
 * first in sorted order, so this picks the same one.
 */
export function claudeChildHomeDirectory(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string {
  const value =
    platform === "win32"
      ? Object.entries(environment)
          .filter(([name]) => name.toUpperCase() === "USERPROFILE")
          .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))[0]?.[1]
      : environment.HOME;

  return value?.trim() || NodeOS.homedir();
}
