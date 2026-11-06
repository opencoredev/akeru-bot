import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as Path from "effect/Path";
import { SandboxError } from "@opencoredev/sandbox-sdk";
import type { FileInfo, ProviderFiles } from "@opencoredev/sandbox-sdk/provider";
import { quote } from "./BotWorkspaceLifecycle.ts";

const posixPath = Effect.runSync(Path.Path.pipe(Effect.provide(Path.layer)));

/** One guest shell script's outcome, as a shim provider's native exec reports it. */
export interface ScriptResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

const findFormat = `-printf '%p\\037%y\\037%s\\037%T@\\036'`;

function fileInfo(line: string): FileInfo {
  const [path = "", type = "f", size = "0", modifiedAt = "0"] = line.split("\u001f");

  return {
    path,
    type: Match.value(type).pipe(
      Match.when("d", () => "directory" as const),
      Match.when("l", () => "symlink" as const),
      Match.orElse(() => "file" as const),
    ),
    size: Number(size),
    modifiedAt: Math.floor(Number(modifiedAt) * 1_000),
  };
}

/**
 * Sandbox SDK file primitives over guest shell commands, for the shim providers (Ascii Box,
 * legacy Tenki) whose native APIs Akeru drives through scripts. Contents travel base64-encoded.
 */
export function shellFiles(
  provider: string,
  run: (id: string, script: string) => Promise<ScriptResult>,
): ProviderFiles {
  /** Runs a file command and returns stdout; a missing path is `file_not_found`. */
  async function shell(id: string, script: string) {
    const result = await run(id, script);

    if (result.exitCode !== 0)
      throw new SandboxError(result.stderr.trim() || `${provider} file command failed.`, {
        code: /No such file|not found/i.test(result.stderr) ? "file_not_found" : "provider",
        provider,
        sandboxId: id,
      });

    return result.stdout;
  }

  return {
    transfer: "files",
    checkpoints: "files",
    writeCreatesParents: true,
    read: async (id, path) =>
      Buffer.from((await shell(id, `base64 < ${quote(path)}`)).trim(), "base64"),
    write: async (id, path, data, options) => {
      const payload = `printf %s ${quote(Buffer.from(data).toString("base64"))} | base64 -d > ${quote(path)}`;

      // With a mode, a new file is created owner-only before any byte lands, then widened to
      // the requested mode, so a reader in a shared directory such as /tmp never sees it open.
      // The umask stays inside the subshell so parent directories keep the guest default.
      const write =
        options?.mode === undefined
          ? payload
          : `(umask 077 && ${payload}) && chmod ${options.mode.toString(8)} -- ${quote(path)}`;

      await shell(id, `mkdir -p -- ${quote(posixPath.dirname(path))} && ${write}`);
    },
    writeSupportsMode: true,
    list: async (id, path) =>
      (await shell(id, `find ${quote(path)} -mindepth 1 -maxdepth 1 ${findFormat}`))
        .split("\u001e")
        .filter(Boolean)
        .map(fileInfo),
    stat: async (id, path) => {
      const [line] = (await shell(id, `find ${quote(path)} -maxdepth 0 ${findFormat}`)).split(
        "\u001e",
      );

      if (!line)
        throw new SandboxError(`File ${path} not found.`, {
          code: "file_not_found",
          provider,
          sandboxId: id,
        });

      return fileInfo(line);
    },
    remove: async (id, path, options) => {
      await shell(id, `rm ${options.recursive ? "-rf" : "-f"} -- ${quote(path)}`);
    },
    mkdir: async (id, path) => {
      await shell(id, `mkdir -p -- ${quote(path)}`);
    },
  };
}
