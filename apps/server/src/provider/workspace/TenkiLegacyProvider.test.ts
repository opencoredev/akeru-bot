import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createRemoteBotWorkspace } from "../botWorkspace.ts";
import { partialSdkFixture } from "../test-support/partialSdkFixture.ts";
import {
  identityFile,
  legacyIdentity,
  removeIdentityFiles,
  saved,
} from "../test-support/sandboxSdk.ts";
import { workspaceIO } from "../test-support/workspaceIO.ts";

afterEach(() => {
  removeIdentityFiles();
  vi.restoreAllMocks();
});

const encoder = new TextEncoder();

/** A Tenki session the old adapter made: no Sandbox SDK metadata, commands in /home/tenki. */
async function legacyTenkiSession(state: import("@tenkicloud/sandbox").SessionState = "RUNNING") {
  const sdk = await import("@tenkicloud/sandbox");

  const exec = vi.fn(async (command: string | string[], options?: { cwd?: string }) => {
    const argv = [command].flat();
    const stdout = argv[0] === "pwd" ? "/home/tenki\n" : `ran in ${options?.cwd ?? "?"}\n`;

    return {
      status: "COMPLETED" as const,
      exitCode: 0,
      stdout: encoder.encode(stdout),
      stderr: new Uint8Array(),
    };
  });

  const session = partialSdkFixture<import("@tenkicloud/sandbox").Session>({
    id: "tenki-session",
    state,
    metadata: {},
    refresh: vi.fn(async () => undefined),
  });

  // `exec` returns Tenki's full ExecResult, of which Akeru reads the fields supplied here.
  Object.assign(session, { exec });
  vi.spyOn(sdk.TenkiSandbox.prototype, "get").mockResolvedValue(session);

  return { exec };
}

const reattachInput = (file: string) => ({
  io: workspaceIO,
  threadId: "thread-tenki",
  sandbox: "tenki" as const,
  workspaceId: "akeru-tenki",
  identityFile: file,
  environment: { TENKI_API_KEY: "tk_test-key" },
});

describe("Tenki sessions the old adapter created", () => {
  it("reattach through the shim the SDK cannot replace, in the old working directory", async () => {
    const { exec } = await legacyTenkiSession();
    const file = identityFile();
    legacyIdentity(file, "tenki", "tenki-session");

    const workspace = await createRemoteBotWorkspace(reattachInput(file));

    expect(workspace.providerId).toBe("tenki-session");
    expect(saved(file)).toEqual({
      provider: "tenki",
      providerId: "tenki-session",
      workdir: "/home/tenki",
    });
    await expect(workspace.inspect()).resolves.toBe("running");
    await expect(workspace.workspace.sandbox?.executeCommand?.("ls", [])).resolves.toMatchObject({
      success: true,
      stdout: "ran in /home/tenki\n",
    });
    expect(exec).toHaveBeenLastCalledWith(
      ["sh", "-c", expect.stringContaining("'ls'")],
      expect.objectContaining({ cwd: "/home/tenki" }),
    );
  });

  it("fail closed and keep the saved ID when the session has terminated", async () => {
    await legacyTenkiSession("TERMINATED");
    const file = identityFile();
    legacyIdentity(file, "tenki", "tenki-session");

    await expect(createRemoteBotWorkspace(reattachInput(file))).rejects.toThrow(
      `Remove '${file}' to create a replacement`,
    );
    expect(saved(file)).toEqual({ provider: "tenki", providerId: "tenki-session" });
  });
});
