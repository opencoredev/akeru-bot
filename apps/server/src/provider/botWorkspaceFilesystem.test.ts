import { describe, expect, it, vi } from "vite-plus/test";

import { BotWorkspaceFilesystem } from "./botWorkspaceFilesystem.ts";

describe("BotWorkspaceFilesystem", () => {
  it("reads and writes binary-safe content through the remote command session", async () => {
    const run = vi.fn(async (_command: string, args: readonly string[]) => ({
      exitCode: 0,
      stdout: args[1]?.startsWith("base64")
        ? Buffer.from("remote contents").toString("base64")
        : "",
      stderr: "",
    }));
    const filesystem = new BotWorkspaceFilesystem("workspace", "e2b", { run });

    await expect(filesystem.readFile("file.txt", { encoding: "utf8" })).resolves.toBe(
      "remote contents",
    );
    await filesystem.writeFile("file.txt", Buffer.from([0, 1, 2]));

    expect(run).toHaveBeenNthCalledWith(1, "sh", ["-lc", "base64 < 'file.txt'"]);
    expect(run.mock.calls[1]?.[1]?.[1]).toContain(Buffer.from([0, 1, 2]).toString("base64"));
  });
});
