import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Predicate from "effect/Predicate";
import { execa } from "execa";
import { afterEach, describe, expect, it } from "vite-plus/test";
import type { AkeruSandboxFiles } from "./botWorkspace.ts";
import { BotWorkspaceFilesystem } from "./botWorkspaceFilesystem.ts";
import { commandLine } from "./workspace/BotWorkspaceLifecycle.ts";
import { shellFiles } from "./workspace/ShellFiles.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) NodeFS.rmSync(root, { recursive: true, force: true });
});

function read(path: string): Promise<string>;
function read(path: string, options: { as: "bytes" }): Promise<Uint8Array>;
async function read(path: string, options?: { as: "bytes" }): Promise<string | Uint8Array> {
  const data = await NodeFS.promises.readFile(path);

  return options ? new Uint8Array(data) : data.toString("utf8");
}

function write(path: string, data: string | Uint8Array): Promise<void>;
function write(files: Record<string, string | Uint8Array>): Promise<void>;
async function write(
  target: string | Record<string, string | Uint8Array>,
  data?: string | Uint8Array,
) {
  const entries = Predicate.isString(target)
    ? [[target, data ?? ""] as const]
    : Object.entries(target);

  for (const [path, content] of entries) {
    await NodeFS.promises.mkdir(NodePath.dirname(path), { recursive: true });
    await NodeFS.promises.writeFile(path, content);
  }
}

/** Host files and a real `/bin/sh`: what a sandbox guest does, on this machine's disk. */
const hostFiles: AkeruSandboxFiles = {
  read,
  write,
  list: async () => [],
  stat: async (path) => {
    const stat = await NodeFS.promises.stat(path);

    return {
      path,
      type: stat.isDirectory() ? "directory" : "file",
      size: stat.size,
      modifiedAt: stat.mtimeMs,
    };
  },
  exists: async (path) => NodeFS.existsSync(path),
  remove: async (path) => NodeFS.promises.rm(path, { recursive: true, force: true }),
};

/**
 * GNU cat copies a regular file in one copy_file_range call, so on this machine appends would
 * never split. Guest images differ (busybox cat, streamed exec transports), so the shell here
 * gets a `cat` that writes in 512-byte pieces, the case the guest lock exists for.
 *
 * `lock: "mkdir"` gives the shell a PATH with only the tools the fallback uses, so `flock`
 * is not found, as on a minimal image.
 */
function toolbox(root: string, lock: Lock) {
  const bin = NodePath.join(root, `.bin-${lock}`);
  NodeFS.mkdirSync(bin, { recursive: true });

  if (!NodeFS.existsSync(NodePath.join(bin, "cat"))) {
    NodeFS.writeFileSync(
      NodePath.join(bin, "cat"),
      '#!/bin/sh\n[ "$1" = "--" ] && shift\nexec dd if="$1" bs=512 status=none\n',
      { mode: 0o755 },
    );

    for (const tool of ["sh", "dd", "mkdir", "rmdir", "sleep", "dirname"])
      NodeFS.symlinkSync(whichSync(tool), NodePath.join(bin, tool));
  }

  return lock === "flock" ? `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}` : bin;
}

type Lock = "flock" | "mkdir";

/** `flock` ships with util-linux; macOS and other hosts without it run only the fallback. */
const hostHasFlock = (process.env.PATH ?? "")
  .split(NodePath.delimiter)
  .some((directory) => directory !== "" && NodeFS.existsSync(NodePath.join(directory, "flock")));

const hostLocks: ReadonlyArray<Lock> = hostHasFlock ? ["flock", "mkdir"] : ["mkdir"];

function whichSync(tool: string) {
  const found = ["/usr/bin", "/bin"].map((dir) => NodePath.join(dir, tool)).find(NodeFS.existsSync);

  if (!found) throw new Error(`${tool} is not installed.`);

  return found;
}

function session(root: string, lock: Lock = "flock") {
  const path = toolbox(root, lock);

  return {
    workdir: root,
    files: hostFiles,
    run: async (command: string, args: readonly string[]) => {
      const result = await execa("/bin/sh", ["-c", commandLine(command, args)], {
        cwd: root,
        reject: false,
        encoding: "utf8",
        env: { PATH: path },
        extendEnv: false,
      });

      return { exitCode: result.exitCode ?? 1, stdout: result.stdout, stderr: result.stderr };
    },
  };
}

function workspaceRoot() {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-append-"));
  roots.push(root);

  return root;
}

const MIB = 1024 * 1024;

/** The guest lock file Akeru uses for appends to `path`; the mkdir fallback adds `.d`. */
function lockFor(path: string) {
  const lock = `/tmp/.akeru-append-lock-${NodeCrypto.createHash("sha256").update(path).digest("hex").slice(0, 32)}`;
  locks.push(lock);

  return lock;
}

const locks: string[] = [];

afterEach(() => {
  for (const lock of locks.splice(0)) NodeFS.rmSync(lock, { force: true });
});

/**
 * Holds `lock` with flock in another process until killed, as a live session would. The
 * process is returned inside an object: execa's subprocess is a promise, and returning it
 * directly from an async function would wait for it to exit.
 */
async function flockHolder(lock: string) {
  // One process holds fd 9 and becomes `sleep`, so killing it releases the lock.
  const process = execa("sh", ["-c", 'exec 9>>"$1" && flock 9 && exec sleep 30', "sh", lock], {
    reject: false,
  });

  // Wait until the holder has the lock: a non-blocking try fails while it is held.
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const probe = await execa("flock", ["-n", lock, "true"], { reject: false });

    if (probe.exitCode !== 0) return { process };
    await execa("sleep", ["0.05"]);
  }

  process.kill("SIGKILL");
  throw new Error("The flock holder never took the lock.");
}

describe.each<Lock>(hostLocks)("appends against a real shell, %s lock", (lock) => {
  it("keeps concurrent multi-megabyte appends from separate sessions whole", async () => {
    const root = workspaceRoot();
    NodeFS.writeFileSync(NodePath.join(root, "log.bin"), "start");
    lockFor(NodePath.join(root, "log.bin"));
    const payloads = ["a", "b", "c"].map((fill) => Buffer.alloc(8 * MIB, fill));

    // Separate filesystems are separate sessions: only the guest lock orders them.
    await Promise.all(
      payloads.map((payload, index) =>
        new BotWorkspaceFilesystem(`session-${index}`, "local", session(root, lock)).appendFile(
          "log.bin",
          payload,
        ),
      ),
    );

    const result = NodeFS.readFileSync(NodePath.join(root, "log.bin"));
    expect(result.subarray(0, 5).toString()).toBe("start");
    expect(result.length).toBe(5 + 3 * 8 * MIB);

    // Each payload must sit in one unbroken run of its fill byte.
    const runs = new Set<number>();
    let previous = -1;

    for (let offset = 5; offset < result.length; offset += 64 * 1024) {
      const byte = result[offset] ?? -1;

      if (byte !== previous) {
        expect(runs.has(byte)).toBe(false);
        runs.add(byte);
        previous = byte;
      }
    }

    expect(runs.size).toBe(3);
  });

  it("waits for a live holder, then appends once it lets go", async () => {
    const root = workspaceRoot();
    const target = NodePath.join(root, "log.txt");
    NodeFS.writeFileSync(target, "start\n");
    const file = lockFor(target);
    const fs = new BotWorkspaceFilesystem("waits", "local", session(root, lock));

    const holder = lock === "flock" ? await flockHolder(file) : undefined;

    if (lock === "mkdir") NodeFS.mkdirSync(`${file}.d`);

    const pending = fs.appendFile("log.txt", "first\n");
    await execa("sleep", ["0.5"]);
    expect(NodeFS.readFileSync(target, "utf8")).toBe("start\n");

    if (holder) holder.process.kill("SIGKILL");
    else NodeFS.rmdirSync(`${file}.d`);

    await pending;
    expect(NodeFS.readFileSync(target, "utf8")).toBe("start\nfirst\n");
    expect(NodeFS.existsSync(`${file}.d`)).toBe(false);
  });

  it("fails with exit 75 when the lock stays held, and leaves the holder's lock alone", async () => {
    const root = workspaceRoot();
    const target = NodePath.join(root, "log.txt");
    NodeFS.writeFileSync(target, "start\n");
    const file = lockFor(target);

    const fs = new BotWorkspaceFilesystem("held", "local", session(root, lock), {
      appendLockWaitSeconds: 1,
    });

    const holder = lock === "flock" ? await flockHolder(file) : undefined;

    // The fallback never breaks a lock, however old: its holder may still be appending.
    if (lock === "mkdir") {
      NodeFS.mkdirSync(`${file}.d`);
      const old = new Date(Date.now() - 60 * 60_000);
      NodeFS.utimesSync(`${file}.d`, old, old);
    }

    try {
      await expect(fs.appendFile("log.txt", "late\n")).rejects.toThrow(
        "Another session holds the append lock",
      );
      expect(NodeFS.readFileSync(target, "utf8")).toBe("start\n");

      if (lock === "mkdir") expect(NodeFS.existsSync(`${file}.d`)).toBe(true);
      else expect((await execa("flock", ["-n", file, "true"], { reject: false })).exitCode).toBe(1);
    } finally {
      holder?.process.kill("SIGKILL");
      NodeFS.rmSync(`${file}.d`, { recursive: true, force: true });
    }
  });
});

describe("the flock guest lock", () => {
  it.skipIf(!hostHasFlock)(
    "is released by the kernel when its holder dies, without any cleanup",
    async () => {
      const root = workspaceRoot();
      const target = NodePath.join(root, "log.txt");
      NodeFS.writeFileSync(target, "start\n");
      const file = lockFor(target);
      const holder = await flockHolder(file);
      holder.process.kill("SIGKILL");
      await holder.process;

      const fs = new BotWorkspaceFilesystem("dead-holder", "local", session(root), {
        appendLockWaitSeconds: 1,
      });

      await fs.appendFile("log.txt", "after\n");
      expect(NodeFS.readFileSync(target, "utf8")).toBe("start\nafter\n");
    },
  );

  it("removes only an empty directory without recursion on shell-backed providers", async () => {
    const root = workspaceRoot();
    NodeFS.mkdirSync(NodePath.join(root, "empty"));
    NodeFS.mkdirSync(NodePath.join(root, "full"));
    NodeFS.writeFileSync(NodePath.join(root, "full/kept.txt"), "kept");

    // Ascii Box and legacy Tenki remove files through these guest shell primitives.
    const shell = shellFiles("ascii", async (_id, script) => {
      const result = await execa("/bin/sh", ["-c", script], { reject: false, encoding: "utf8" });

      return { exitCode: result.exitCode ?? 1, stdout: result.stdout, stderr: result.stderr };
    });

    const files: AkeruSandboxFiles = {
      ...hostFiles,
      remove: (path, options) =>
        shell.remove("box", path, { recursive: options?.recursive === true }),
    };

    const fs = new BotWorkspaceFilesystem("shell-rmdir", "ascii", { ...session(root), files });
    await fs.rmdir("empty");
    expect(NodeFS.existsSync(NodePath.join(root, "empty"))).toBe(false);
    await expect(fs.rmdir("full")).rejects.toThrow();
    expect(NodeFS.readFileSync(NodePath.join(root, "full/kept.txt"), "utf8")).toBe("kept");
    await fs.rmdir("full", { recursive: true });
    expect(NodeFS.existsSync(NodePath.join(root, "full"))).toBe(false);
  });

  it("creates a shell-written file owner-only before its payload lands", async () => {
    const root = workspaceRoot();
    const target = NodePath.join(root, "staged");
    const stubs = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-chmod-"));
    roots.push(stubs);
    const record = NodePath.join(stubs, "modes");

    // This chmod notes the file's mode as the redirect left it, then runs the real one.
    NodeFS.writeFileSync(
      NodePath.join(stubs, "chmod"),
      `#!/bin/sh\n{ stat -c %a "$3" 2>/dev/null || stat -f %Lp "$3"; } >> ${record}\nexec /bin/chmod "$@"\n`,
      { mode: 0o755 },
    );

    // Ascii Box and legacy Tenki stage append payloads through this write; a guest image
    // with umask 022 must not leave the payload world-readable before chmod runs.
    const shell = shellFiles("ascii", async (_id, script) => {
      const result = await execa("/bin/sh", ["-c", `umask 022; ${script}`], {
        reject: false,
        encoding: "utf8",
        env: { PATH: `${stubs}:${process.env.PATH ?? ""}` },
      });

      return { exitCode: result.exitCode ?? 1, stdout: result.stdout, stderr: result.stderr };
    });

    await shell.write("box", target, Buffer.from("secret"), { mode: 0o600 });
    expect(NodeFS.readFileSync(record, "utf8").trim()).toBe("600");
    expect(NodeFS.statSync(target).mode & 0o777).toBe(0o600);
    expect(NodeFS.readFileSync(target, "utf8")).toBe("secret");

    // Directories the write creates keep the guest's default mode.
    await shell.write("box", NodePath.join(root, "nested/readable"), Buffer.from("open"), {
      mode: 0o644,
    });
    expect(NodeFS.statSync(NodePath.join(root, "nested")).mode & 0o777).toBe(0o755);
    expect(NodeFS.statSync(NodePath.join(root, "nested/readable")).mode & 0o777).toBe(0o644);
  });

  it("writes through the session's shell for a session running as its own user", async () => {
    const root = workspaceRoot();
    lockFor(NodePath.join(root, "nested/dir/notes.md"));
    const asUser = { ...session(root), user: "user" };
    const sdkWrites: string[] = [];
    const stagingModes: number[] = [];

    function recordingWrite(path: string, data: string | Uint8Array): Promise<void>;
    function recordingWrite(files: Record<string, string | Uint8Array>): Promise<void>;
    async function recordingWrite(
      target: string | Record<string, string | Uint8Array>,
      data?: string | Uint8Array,
    ) {
      if (Predicate.isString(target)) {
        sdkWrites.push(target);
        stagingModes.push(NodeFS.statSync(NodePath.dirname(target)).mode & 0o777);
        await hostFiles.write(target, data ?? "");
      } else {
        sdkWrites.push(...Object.keys(target));
        await hostFiles.write(target);
      }
    }

    const files = { ...hostFiles, write: recordingWrite };

    // The shell stands in for `su user`; what matters is that the file is written by it.
    const fs = new BotWorkspaceFilesystem("as-user", "local", { ...asUser, files });
    await fs.writeFile("nested/dir/notes.md", "hello");
    await fs.appendFile("nested/dir/notes.md", " world");

    expect(NodeFS.readFileSync(NodePath.join(root, "nested/dir/notes.md"), "utf8")).toBe(
      "hello world",
    );
    expect(sdkWrites.every((path) => path.startsWith("/tmp/.akeru-append-"))).toBe(true);
    // The readable payload sits in a directory only the session's user can enter.
    expect(sdkWrites.every((path) => NodePath.basename(path) === "payload")).toBe(true);
    expect(stagingModes).toEqual([0o700, 0o700]);
    expect(sdkWrites.some((path) => NodeFS.existsSync(NodePath.dirname(path)))).toBe(false);
  });
});
