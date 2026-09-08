// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { listTranscriptFiles, readTranscriptRecords } from "./usageTranscriptReader.ts";

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof NodeFSP>();
  return { ...original, readdir: vi.fn(original.readdir) };
});

const directories: string[] = [];
const tempDirectory = async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "akeru-usage-reader-"));
  directories.push(directory);
  return directory;
};
const line = JSON.stringify({
  type: "assistant",
  timestamp: "2026-09-07T04:05:13.944Z",
  sessionId: "s",
  message: { id: "m", model: "claude-fable-5", usage: { input_tokens: 1, output_tokens: 2 } },
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0))
    await NodeFSP.rm(directory, { recursive: true, force: true });
});

describe("usage transcript single-flight", () => {
  it("shares directory walks across time windows, not the filtered results", async () => {
    const directory = await tempDirectory();
    const file = NodePath.join(directory, "session.jsonl");
    await NodeFSP.writeFile(file, line);
    const readdir = vi.mocked(NodeFSP.readdir);
    readdir.mockClear();
    const [all, none] = await Promise.all([
      listTranscriptFiles(directory, 0),
      listTranscriptFiles(directory, Infinity),
    ]);
    expect(all.map((entry) => entry.path)).toEqual([file]);
    expect(none).toEqual([]);
    expect(readdir).toHaveBeenCalledTimes(1);
    await listTranscriptFiles(directory, 0);
    expect(readdir).toHaveBeenCalledTimes(2);
  });

  it("shares only simultaneous reads for the same provider and file version", async () => {
    const file = NodePath.join(await tempDirectory(), "session.jsonl");
    await NodeFSP.writeFile(file, line + "\n");
    const version = { size: Buffer.byteLength(line) + 1, mtimeMs: 1 };
    const first = readTranscriptRecords(file, "claude", version);
    expect(readTranscriptRecords(file, "claude", version)).toBe(first);
    const otherProvider = readTranscriptRecords(file, "codex", version);
    const otherVersion = readTranscriptRecords(file, "claude", { ...version, mtimeMs: 2 });
    expect(otherProvider).not.toBe(first);
    expect(otherVersion).not.toBe(first);
    expect((await first)?.length).toBe(1);
    await Promise.all([otherProvider, otherVersion]);
    const later = readTranscriptRecords(file, "claude", version);
    expect(later).not.toBe(first);
    await later;
  });

  it("reparses partial final lines, truncations, and replacements without retaining stale parser state", async () => {
    const file = NodePath.join(await tempDirectory(), "session.jsonl");
    const read = async () => readTranscriptRecords(file, "claude", await NodeFSP.stat(file));
    await NodeFSP.writeFile(file, line.slice(0, -4));
    expect(await read()).toEqual([]);
    await NodeFSP.appendFile(file, line.slice(-4));
    expect((await read())?.map((record) => record.dedupeKey)).toEqual(["m:"]);
    await NodeFSP.writeFile(file, "");
    expect(await read()).toEqual([]);
    await NodeFSP.writeFile(file, line.replace('"m"', '"replacement"') + "\n");
    expect((await read())?.map((record) => record.dedupeKey)).toEqual(["replacement:"]);
  });

  it("shares read failures without retaining them after the file becomes readable", async () => {
    const file = NodePath.join(await tempDirectory(), "missing.jsonl");
    const first = readTranscriptRecords(file, "claude");
    expect(readTranscriptRecords(file, "claude")).toBe(first);
    expect(await first).toBeNull();
    await NodeFSP.writeFile(file, line);
    expect((await readTranscriptRecords(file, "claude"))?.length).toBe(1);
  });
});
