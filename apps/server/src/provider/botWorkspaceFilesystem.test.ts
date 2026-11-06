import { createSandbox } from "@opencoredev/sandbox-sdk";
import { memory } from "@opencoredev/sandbox-sdk/memory";
import { describe, expect, it, vi } from "vite-plus/test";

import { BotWorkspaceFilesystem } from "./botWorkspaceFilesystem.ts";
import { commandLine } from "./workspace/BotWorkspaceLifecycle.ts";

/**
 * A memory sandbox whose `sh` runs guest appends in one synchronous step, as if the guest lock
 * were held. It understands Akeru's staged append (`cat "$1" >> "$2"`) and, so regressions
 * show, the earlier chunked `base64 -d >> "$2"` form. A real shell is in the `.shell` tests.
 * `failOnCall` makes the `sh` call with that 1-based number fail. `cp` succeeds without copying.
 */
async function filesystem() {
  const provider = memory({ handlers: { cp: () => 0 } });
  const box = await createSandbox(provider);
  const control = { failOnCall: 0, calls: 0 };

  provider.register("sh", ({ args, cwd, stderr }) => {
    control.calls += 1;
    const [flag, script = "", , source = "", file = ""] = args;
    const target = file.startsWith("/") ? file : `${cwd}/${file}`;
    const nodes = provider.native(box.id).files;
    const staged = script.includes('cat -- "$1" >> "$2"');

    if (flag !== "-c" || (!staged && !script.endsWith('base64 -d >> "$2"'))) {
      stderr("unsupported shell script\n");

      return 127;
    }

    const payload = staged ? nodes.get(source)?.data : Buffer.from(source, "base64");

    if (staged) nodes.delete(source);

    if (!payload || control.calls === control.failOnCall) {
      stderr("append failed\n");

      return 1;
    }

    const existing = nodes.get(target);

    nodes.set(target, {
      data: existing?.data ? Buffer.concat([existing.data, payload]) : payload,
      modifiedAt: existing?.modifiedAt ?? 0,
      mode: existing?.mode ?? 0o644,
    });

    return 0;
  });

  const run = vi.fn(async (command: string, args: readonly string[]) => {
    const result = await box.run(commandLine(command, args));

    return { exitCode: result.exitCode ?? 1, stdout: result.stdout, stderr: result.stderr };
  });

  return {
    box,
    run,
    control,
    filesystem: new BotWorkspaceFilesystem("workspace", "memory", { files: box.files, run }),
  };
}

const appendCommands = (run: ReturnType<typeof vi.fn>) =>
  run.mock.calls.filter(([command]) => command === "sh").length;

async function stagedFiles(box: Awaited<ReturnType<typeof filesystem>>["box"]) {
  return (await box.files.list("/tmp")).filter((entry) => entry.path.includes(".akeru-append-"));
}

describe("BotWorkspaceFilesystem", () => {
  it("reads and writes binary-safe content through sandbox-sdk files", async () => {
    const { box, filesystem: fs } = await filesystem();

    await fs.writeFile("nested/file.bin", Buffer.from([0, 1, 2, 255]));
    expect([...(await box.files.read("/workspace/nested/file.bin", { as: "bytes" }))]).toEqual([
      0, 1, 2, 255,
    ]);
    await fs.writeFile("notes.txt", "remote contents");
    await fs.appendFile("notes.txt", " and more");
    await expect(fs.readFile("notes.txt", { encoding: "utf8" })).resolves.toBe(
      "remote contents and more",
    );
    await box.destroy();
  });

  it("lists, stats and removes entries relative to the listed directory", async () => {
    const { box, filesystem: fs } = await filesystem();

    await fs.writeFile("src/a.ts", "a");
    await fs.writeFile("src/deep/b.ts", "bb");
    await fs.writeFile("src/c.md", "c");

    expect((await fs.readdir("src")).map((entry) => entry.name).toSorted()).toEqual([
      "a.ts",
      "c.md",
      "deep",
    ]);
    expect(
      (await fs.readdir("src", { recursive: true, extension: ".ts" }))
        .map((entry) => entry.name)
        .toSorted(),
    ).toEqual(["a.ts", "deep/b.ts"]);
    await expect(fs.stat("src/deep/b.ts")).resolves.toMatchObject({ type: "file", size: 2 });
    await expect(fs.stat("src/deep")).resolves.toMatchObject({ type: "directory", size: 0 });

    await fs.deleteFile("src/a.ts");
    await expect(fs.exists("src/a.ts")).resolves.toBe(false);
    await expect(fs.deleteFile("src/a.ts")).rejects.toThrow("does not exist");
    await fs.deleteFile("src/a.ts", { force: true });
    await fs.rmdir("src", { recursive: true });
    await expect(fs.exists("src")).resolves.toBe(false);
    await box.destroy();
  });

  it("reads no deeper than maxDepth when listing recursively", async () => {
    const { box, filesystem: fs } = await filesystem();

    await fs.writeFile("src/a.ts", "a");
    await fs.writeFile("src/deep/b.ts", "b");
    await fs.writeFile("src/deep/node_modules/pkg/index.js", "c");
    const list = vi.spyOn(box.files, "list");

    expect(
      (await fs.readdir("src", { recursive: true, maxDepth: 2 }))
        .map((entry) => entry.name)
        .toSorted(),
    ).toEqual(["a.ts", "deep", "deep/b.ts", "deep/node_modules"]);
    expect(list.mock.calls.map(([path]) => path).toSorted()).toEqual([
      "/workspace/src",
      "/workspace/src/deep",
    ]);
    expect(list.mock.calls.some(([, options]) => options?.recursive)).toBe(false);
    await box.destroy();
  });

  it("keeps both of two concurrent appends to one file", async () => {
    const { box, filesystem: fs } = await filesystem();

    await fs.writeFile("log.txt", "start\n");
    await Promise.all([fs.appendFile("log.txt", "first\n"), fs.appendFile("log.txt", "second\n")]);

    const lines = String(await fs.readFile("log.txt", { encoding: "utf8" })).split("\n");
    expect(lines.toSorted()).toEqual(["", "first", "second", "start"]);
    await box.destroy();
  });

  it("appends large content with one command, and creates missing files", async () => {
    const { box, run, filesystem: fs } = await filesystem();
    const large = Buffer.alloc(120 * 1024, "ab'$(x)`");

    await fs.appendFile("big.bin", large);
    await fs.appendFile("empty.txt", "");
    expect(Buffer.from(await box.files.read("/workspace/big.bin", { as: "bytes" }))).toEqual(large);
    await expect(fs.exists("empty.txt")).resolves.toBe(true);
    expect(appendCommands(run)).toBe(2);
    await expect(stagedFiles(box)).resolves.toEqual([]);
    await box.destroy();
  });

  it("never interleaves two concurrent large appends", async () => {
    const { box, filesystem: fs } = await filesystem();
    const first = Buffer.alloc(120 * 1024, "a");
    const second = Buffer.alloc(120 * 1024, "b");

    await fs.writeFile("log.bin", "start");
    await Promise.all([fs.appendFile("log.bin", first), fs.appendFile("log.bin", second)]);

    const result = Buffer.from(await box.files.read("/workspace/log.bin", { as: "bytes" }));
    const start = Buffer.from("start");
    expect([
      Buffer.concat([start, first, second]).equals(result),
      Buffer.concat([start, second, first]).equals(result),
    ]).toContain(true);
    await box.destroy();
  });

  it("lands a large append whole or not at all when a later guest command fails", async () => {
    const { box, control, filesystem: fs } = await filesystem();
    const large = Buffer.alloc(120 * 1024, "z");
    await fs.writeFile("log.bin", "start");

    // A chunked append would commit its first chunk and then fail on the second command.
    control.failOnCall = 2;

    const appended = await fs.appendFile("log.bin", large).then(
      () => true,
      () => false,
    );

    const result = Buffer.from(await box.files.read("/workspace/log.bin", { as: "bytes" }));
    const expected = appended ? Buffer.concat([Buffer.from("start"), large]) : Buffer.from("start");
    expect(result.equals(expected)).toBe(true);
    await box.destroy();
  });

  it("reports a failed final append once, commits nothing, and leaves no staged file", async () => {
    const { box, run, control, filesystem: fs } = await filesystem();
    await fs.writeFile("log.txt", "start\n");
    control.failOnCall = 1;

    await expect(fs.appendFile("log.txt", "more\n")).rejects.toThrow("append failed");
    await expect(fs.readFile("log.txt", { encoding: "utf8" })).resolves.toBe("start\n");
    expect(appendCommands(run)).toBe(1);
    await expect(stagedFiles(box)).resolves.toEqual([]);
    await box.destroy();
  });

  it("creates missing parents only for a recursive write", async () => {
    const { box, filesystem: fs } = await filesystem();

    await expect(
      fs.writeFile("missing/dir/note.txt", "draft", { recursive: false }),
    ).rejects.toThrow("does not exist");
    expect(await fs.exists("missing/dir")).toBe(false);

    await fs.writeFile("made/dir/note.txt", "draft");
    expect(String(await fs.readFile("made/dir/note.txt", { encoding: "utf8" }))).toBe("draft");
    await box.destroy();
  });

  it("refuses to overwrite when asked and runs copies as commands", async () => {
    const { box, run, filesystem: fs } = await filesystem();

    await fs.writeFile("keep.txt", "first");
    await expect(fs.writeFile("keep.txt", "second", { overwrite: false })).rejects.toThrow(
      "already exists",
    );
    await fs.copyFile("keep.txt", "copy.txt", { overwrite: false });
    expect(run).toHaveBeenCalledWith("cp", [
      "-n",
      "--",
      "/workspace/keep.txt",
      "/workspace/copy.txt",
    ]);
    await box.destroy();
  });
});
