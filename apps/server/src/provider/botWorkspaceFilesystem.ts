import * as Effect from "effect/Effect";
import * as NodeCrypto from "node:crypto";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";

import type {
  CopyOptions,
  FileContent,
  FileEntry,
  FileStat,
  ListOptions,
  ReadOptions,
  RemoveOptions,
  ProviderStatus,
  WorkspaceFilesystem,
  WriteOptions,
} from "@mastra/core/workspace";
import type { AkeruRemoteSession } from "./workspace/BotWorkspaceTypes.ts";
import { oneAtATime } from "./workspace/oneAtATime.ts";

const posixPath = Effect.runSync(Path.Path.pipe(Effect.provide(Path.layer)));

type SandboxFileInfo = Awaited<ReturnType<AkeruRemoteSession["files"]["list"]>>[number];

/** Directories a depth-bounded listing reads at once. */
const LIST_CONCURRENCY = 8;

/** The working directory of sandboxes created since the sandbox-sdk migration. */
export const SANDBOX_WORKDIR = "/workspace";

/**
 * Appends the staged file `$1` to `$2` while holding the guest lock `$3`, waiting at most `$4`
 * seconds for it. `cat` writes in pieces and O_APPEND keeps only each piece whole, so
 * concurrent appends from other sessions take turns on the lock.
 *
 * With `flock`, the lock is a file the kernel unlocks when its holder exits, so a dead holder
 * never blocks anyone. Without it, `mkdir "$3.d"` is the lock and is never broken: a lock that
 * stays held past the wait fails the append with exit 75 rather than removing a lock that may
 * belong to a live session. `command exec` keeps a failed redirection from ending the shell, and
 * the braces keep `2>/dev/null` from silencing the rest of the script; a
 * lock file another user created is opened read-only, which `flock` accepts.
 * That `cat >>` is the append's only commit point. Paths arrive as quoted arguments.
 */
const APPEND_SCRIPT = [
  "lock=$3; wait=$4",
  'held() { echo "Another session holds the append lock for $1; gave up after ${wait}s." >&2; exit 75; }',
  "if command -v flock >/dev/null 2>&1; then",
  '  { command exec 9>>"$lock"; } 2>/dev/null || { command exec 9<"$lock"; } 2>/dev/null || held "$2"',
  '  flock -w "$wait" 9 || held "$2"',
  "else",
  "  tries=0",
  '  until mkdir "$lock.d" 2>/dev/null; do',
  '    tries=$((tries + 1)); [ "$tries" -le $((wait * 10)) ] || held "$2"',
  "    sleep 0.1 2>/dev/null || sleep 1",
  "  done",
  "  trap 'rmdir \"$lock.d\" 2>/dev/null' EXIT",
  "fi",
  'cat -- "$1" >> "$2"',
].join("\n");

/** How long an append waits for another session's guest lock before failing with exit 75. */
const APPEND_LOCK_WAIT_SECONDS = 60;

/** Replaces `$2` with the staged file `$1`, creating missing parents, as the session's user. */
const WRITE_SCRIPT = 'mkdir -p -- "$(dirname -- "$2")" && cat -- "$1" > "$2"';

type RemoteFileSession = Pick<AkeruRemoteSession, "files" | "run" | "workdir" | "user">;

/** A Mastra filesystem over a sandbox-sdk handle's `files`, with `cp`/`mv`/`mkdir` as commands. */
export class BotWorkspaceFilesystem implements WorkspaceFilesystem {
  readonly id: string;
  readonly name: string;
  readonly provider: string;
  readonly status: ProviderStatus = "ready";
  private readonly session: RemoteFileSession;
  private readonly appendLockWaitSeconds: number;

  constructor(
    id: string,
    provider: string,
    session: RemoteFileSession,
    options: { readonly appendLockWaitSeconds?: number } = {},
  ) {
    this.id = `${id}-filesystem`;
    this.name = `Akeru ${provider}`;
    this.provider = provider;
    this.session = session;
    this.appendLockWaitSeconds = options.appendLockWaitSeconds ?? APPEND_LOCK_WAIT_SECONDS;
  }

  async readFile(input: string, options?: ReadOptions): Promise<string | Buffer> {
    const path = this.at(input);

    const content = Buffer.from(await this.session.files.read(path, { as: "bytes" }));

    return options?.encoding ? content.toString(options.encoding) : content;
  }

  async writeFile(input: string, content: FileContent, options?: WriteOptions): Promise<void> {
    const path = this.at(input);

    if (options?.overwrite === false && (await this.session.files.exists(path)))
      throw new Error(`File '${path}' already exists.`);

    // Both write paths create missing parents, so a non-recursive write checks for one first.
    if (options?.recursive === false) {
      const parent = posixPath.dirname(path);

      if (!(await this.session.files.exists(parent)))
        throw new Error(`Directory '${parent}' does not exist.`);
    }

    if (options?.expectedMtime) {
      const current = await this.session.files.stat(path);

      if (
        Math.floor(current.modifiedAt / 1_000) !==
        Math.floor(options.expectedMtime.getTime() / 1_000)
      )
        throw new Error(`File '${path}' changed since it was read.`);
    }

    // The SDK writes as its own user. A session that runs as another user writes through a
    // command as that user, so the file and any new parents belong to it.
    if (this.session.user) {
      await this.staged(content, async (staged) => {
        await this.command("sh", ["-c", WRITE_SCRIPT, "sh", staged, path]);
      });

      return;
    }

    await this.session.files.write(path, bytes(content));
  }

  /**
   * Stages the whole payload in a private guest file through the SDK's file API, then appends
   * it with one `cat >>` under a guest lock that every session appending to `path` shares.
   * Appends through this workspace also queue in-process. A failure before the `cat` changes
   * nothing, and a failed final append is reported, not retried, since it may already have
   * written.
   */
  async appendFile(input: string, content: FileContent): Promise<void> {
    const path = this.at(input);
    const lock = `/tmp/.akeru-append-lock-${NodeCrypto.createHash("sha256").update(path).digest("hex").slice(0, 32)}`;

    await oneAtATime(`${this.id}:${path}`, () =>
      this.staged(content, async (staged) => {
        await this.command("sh", [
          "-c",
          APPEND_SCRIPT,
          "sh",
          staged,
          path,
          lock,
          String(this.appendLockWaitSeconds),
        ]);
      }),
    );
  }

  /** Writes `content` to a private /tmp file, hands its path to `use`, and removes it after. */
  private async staged(content: FileContent, use: (staged: string) => Promise<void>) {
    const name = `/tmp/.akeru-append-${NodeCrypto.randomUUID()}`;

    // A session running as another user cannot read a 0600 file the SDK writes as its own
    // user, so that user first makes a 0700 directory and the readable payload goes inside it.
    // Only that user and the SDK's can reach it.
    if (this.session.user) await this.command("mkdir", ["-m", "700", "--", name]);
    const staged = this.session.user ? `${name}/payload` : name;

    try {
      await this.session.files.write(staged, bytes(content), {
        mode: this.session.user ? 0o644 : 0o600,
      });
      await use(staged);
    } finally {
      await this.session.files
        .remove(name, this.session.user ? { recursive: true } : undefined)
        .catch(() => undefined);
    }
  }

  async deleteFile(input: string, options?: RemoveOptions): Promise<void> {
    const path = this.at(input);

    if (!(await this.session.files.exists(path))) {
      if (options?.force) return;
      throw new Error(`File '${path}' does not exist.`);
    }

    await this.session.files.remove(path);
  }

  async copyFile(src: string, dest: string, options?: CopyOptions): Promise<void> {
    await this.command(
      "cp",
      [
        options?.recursive ? "-R" : "",
        options?.overwrite === false ? "-n" : "",
        "--",
        this.at(src),
        this.at(dest),
      ].filter(Boolean),
    );
  }

  async moveFile(src: string, dest: string, options?: CopyOptions): Promise<void> {
    await this.command(
      "mv",
      [options?.overwrite === false ? "-n" : "", "--", this.at(src), this.at(dest)].filter(Boolean),
    );
  }

  async mkdir(input: string, options?: { recursive?: boolean }): Promise<void> {
    const path = this.at(input);

    await this.command("mkdir", [options?.recursive ? "-p" : "", "--", path].filter(Boolean));
  }

  async rmdir(input: string, options?: RemoveOptions): Promise<void> {
    const path = this.at(input);

    if (!(await this.session.files.exists(path))) {
      if (options?.force) return;
      throw new Error(`Directory '${path}' does not exist.`);
    }

    if (options?.recursive) {
      await this.session.files.remove(path, { recursive: true });

      return;
    }

    // A non-recursive SDK remove is `rm -f` on the shell-backed providers, which refuses
    // directories, so an empty one is removed with `rmdir`. It still fails on a non-empty one.
    await this.command("rmdir", ["--", path]);
  }

  async readdir(input: string, options?: ListOptions): Promise<FileEntry[]> {
    const path = this.at(input);

    const maxDepth = options?.recursive ? options.maxDepth : 1;

    const extensions = options?.extension
      ? Array.isArray(options.extension)
        ? options.extension
        : [options.extension]
      : undefined;

    const entries =
      maxDepth === undefined
        ? await this.session.files.list(path, { recursive: true })
        : await this.listTo(path, maxDepth);

    return entries
      .map((entry) => ({ entry, name: posixPath.relative(path, entry.path) }))
      .filter(({ name }) => !extensions || extensions.some((extension) => name.endsWith(extension)))
      .map(({ entry, name }) => ({
        name,
        type: entry.type === "directory" ? ("directory" as const) : ("file" as const),
        ...(entry.type === "directory" ? {} : { size: entry.size }),
        ...(entry.type === "symlink" ? { isSymlink: true } : {}),
      }));
  }

  /**
   * Lists `root` one level at a time down to `maxDepth`. The SDK's recursive list has no depth
   * bound, so a shallow listing above `node_modules` would otherwise walk the whole tree.
   */
  private async listTo(root: string, maxDepth: number): Promise<SandboxFileInfo[]> {
    const entries: SandboxFileInfo[] = [];
    let level = [root];

    for (let depth = 1; depth <= maxDepth && level.length > 0; depth += 1) {
      const listed: SandboxFileInfo[] = [];

      // A few directories at a time, so a wide level does not flood the provider.
      for (let start = 0; start < level.length; start += LIST_CONCURRENCY) {
        const batch = level.slice(start, start + LIST_CONCURRENCY);
        listed.push(
          ...(await Promise.all(batch.map((dir) => this.session.files.list(dir)))).flat(),
        );
      }

      entries.push(...listed);
      level = listed.flatMap((entry) => (entry.type === "directory" ? [entry.path] : []));
    }

    return entries;
  }

  exists(input: string): Promise<boolean> {
    const path = this.at(input);

    return this.session.files.exists(path);
  }

  async stat(input: string): Promise<FileStat> {
    const path = this.at(input);

    const info = await this.session.files.stat(path);
    const modifiedAt = new Date(info.modifiedAt);

    return {
      name: posixPath.basename(input),
      path: input,
      type: info.type === "directory" ? "directory" : "file",
      size: info.type === "directory" ? 0 : info.size,
      createdAt: modifiedAt,
      modifiedAt,
    };
  }

  /** Relative paths resolve against the session's working directory, as its commands do. */
  private at(path: string): string {
    return posixPath.resolve(this.session.workdir ?? SANDBOX_WORKDIR, path);
  }

  private async command(command: string, args: readonly string[]): Promise<string> {
    const result = await this.session.run(command, args);

    if (result.exitCode !== 0) {
      throw new Error(result.stderr || `${command} exited with code ${result.exitCode}.`);
    }

    return result.stdout;
  }
}

function bytes(content: FileContent): Uint8Array {
  return Predicate.isString(content) ? Buffer.from(content, "utf8") : Buffer.from(content);
}
