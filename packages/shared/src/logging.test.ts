// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { RotatingFileSink, RotatingFileSinkConfigurationError } from "./logging.ts";

const tempDirectories: string[] = [];
const makeTempDirectory = (): string => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-logging-"));
  tempDirectories.push(directory);
  return directory;
};

afterEach(() => {
  for (const directory of tempDirectories.splice(0))
    NodeFS.rmSync(directory, { recursive: true, force: true });
});

describe("RotatingFileSink", () => {
  it.each(["maxBytes", "maxFiles", "maxBufferedBytes", "maxBufferedChunks"] as const)(
    "validates %s before starting I/O",
    (option) => {
      expect(
        () =>
          new RotatingFileSink({ filePath: "/unused/log", maxBytes: 1, maxFiles: 1, [option]: 0 }),
      ).toThrow(RotatingFileSinkConfigurationError);
    },
  );

  it("reports asynchronous initialization failures on flush and close", async () => {
    const parentFile = NodePath.join(makeTempDirectory(), "not-a-directory");
    NodeFS.writeFileSync(parentFile, "occupied");
    const filePath = NodePath.join(parentFile, "log");
    const sink = new RotatingFileSink({ filePath, maxBytes: 10, maxFiles: 1 });
    await expect(sink.flush()).rejects.toMatchObject({ operation: "initialize", filePath });
    await expect(sink.close()).rejects.toMatchObject({ operation: "initialize", filePath });
  });

  it("only treats a missing file as zero bytes", async () => {
    const filePath = NodePath.join(makeTempDirectory(), "a".repeat(300));
    const sink = new RotatingFileSink({ filePath, maxBytes: 10, maxFiles: 1 });
    await expect(sink.close()).rejects.toMatchObject({
      operation: "read",
      cause: { code: "ENAMETOOLONG" },
    });
  });

  it("orders concurrent appends across rotation and drains on close", async () => {
    const filePath = NodePath.join(makeTempDirectory(), "log");
    const sink = new RotatingFileSink({ filePath, maxBytes: 10, maxFiles: 5 });
    const lines = Array.from({ length: 20 }, (_, index) => `${String(index).padStart(2, "0")}\n`);
    const writes = lines.map((line) => sink.write(line));
    await sink.close();
    await Promise.all(writes);
    const retained = [5, 4, 3, 2, 1, 0]
      .map((index) => NodeFS.readFileSync(index === 0 ? filePath : `${filePath}.${index}`, "utf8"))
      .join("");
    expect(retained).toBe(lines.slice(3).join(""));
    expect(NodeFS.existsSync(`${filePath}.6`)).toBe(false);
    expect(sink.bufferedBytes).toBe(0);
    expect(sink.bufferedChunks).toBe(0);
    await expect(sink.write("late")).rejects.toMatchObject({ operation: "closed" });
    await sink.close();
  });

  it("counts UTF-8 bytes and owns buffers until flush", async () => {
    const filePath = NodePath.join(makeTempDirectory(), "log");
    const sink = new RotatingFileSink({ filePath, maxBytes: 6, maxFiles: 1 });
    const buffer = Buffer.from("éé");
    const first = sink.write(buffer);
    buffer.fill(0);
    const second = sink.write("🙂");
    await sink.flush();
    await Promise.all([first, second]);
    expect(NodeFS.readFileSync(`${filePath}.1`, "utf8")).toBe("éé");
    expect(NodeFS.readFileSync(filePath, "utf8")).toBe("🙂");
    await sink.close();
  });

  it("bounds accepted bytes without dropping or retrying accepted chunks", async () => {
    const filePath = NodePath.join(makeTempDirectory(), "log");
    const sink = new RotatingFileSink({
      filePath,
      maxBytes: 100,
      maxFiles: 1,
      maxBufferedBytes: 4,
    });
    const first = sink.write("🙂");
    expect(sink.bufferedBytes).toBe(4);
    await expect(sink.write("x")).rejects.toMatchObject({ operation: "buffer" });
    await first;
    await sink.write("ok");
    await expect(sink.close()).rejects.toMatchObject({ operation: "buffer" });
    expect(NodeFS.readFileSync(filePath, "utf8")).toBe("🙂ok");
  });

  it("bounds the number of queued chunks independently", async () => {
    const filePath = NodePath.join(makeTempDirectory(), "log");
    const sink = new RotatingFileSink({
      filePath,
      maxBytes: 100,
      maxFiles: 1,
      maxBufferedChunks: 1,
    });
    const first = sink.write("a");
    await expect(sink.write("b")).rejects.toMatchObject({ operation: "buffer" });
    await first;
    await expect(sink.close()).rejects.toMatchObject({ operation: "buffer" });
  });

  it("fails queued writes and final flush after a write failure", async () => {
    const filePath = NodePath.join(makeTempDirectory(), "log");
    NodeFS.mkdirSync(filePath);
    const sink = new RotatingFileSink({ filePath, maxBytes: Number.MAX_SAFE_INTEGER, maxFiles: 1 });
    const writes = [sink.write("a"), sink.write("b")];
    const results = await Promise.allSettled(writes);
    expect(results.map((result) => result.status)).toEqual(["rejected", "rejected"]);
    await expect(sink.flush()).rejects.toMatchObject({
      operation: "write",
      cause: { code: "EISDIR" },
    });
    await expect(sink.close()).rejects.toMatchObject({ operation: "write" });
    expect(sink.bufferedBytes).toBe(0);
  });

  it("reports rotation errors before appending, including after an oversized record", async () => {
    const filePath = NodePath.join(makeTempDirectory(), "log");
    NodeFS.mkdirSync(`${filePath}.1`);
    const sink = new RotatingFileSink({ filePath, maxBytes: 1, maxFiles: 1 });
    await sink.write("oversized");
    await expect(sink.write("next")).rejects.toMatchObject({ operation: "rotate" });
    await expect(sink.close()).rejects.toMatchObject({ operation: "rotate" });
    expect(NodeFS.readFileSync(filePath, "utf8")).toBe("oversized");
  });

  it("prunes overflow backups asynchronously and reports pruning failures", async () => {
    const filePath = NodePath.join(makeTempDirectory(), "log");
    NodeFS.writeFileSync(`${filePath}.3`, "old");
    const sink = new RotatingFileSink({ filePath, maxBytes: 10, maxFiles: 1 });
    await sink.close();
    expect(NodeFS.existsSync(`${filePath}.3`)).toBe(false);
    NodeFS.mkdirSync(`${filePath}.2`);
    const broken = new RotatingFileSink({ filePath, maxBytes: 10, maxFiles: 1 });
    await expect(broken.close()).rejects.toMatchObject({ operation: "prune" });
  });
});
