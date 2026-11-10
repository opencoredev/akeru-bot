import { SandboxError } from "@opencoredev/sandbox-sdk";
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
import { withAdoption } from "./SandboxAdoption.ts";

afterEach(() => {
  removeIdentityFiles();
  vi.restoreAllMocks();
});

const RAILWAY = { RAILWAY_API_TOKEN: "token", RAILWAY_ENVIRONMENT_ID: "environment" };

const UPSTASH = { UPSTASH_BOX_API_KEY: "upstash-key" };

const reattachInput = (file: string, sandbox: "railway" | "upstash") => ({
  io: workspaceIO,
  threadId: "thread-legacy",
  sandbox,
  workspaceId: "akeru-legacy",
  identityFile: file,
  environment: sandbox === "railway" ? RAILWAY : UPSTASH,
});

/** A Railway VM made by the old adapter: running, with no Sandbox SDK marker file. */
async function legacyRailwayVm(status: import("railway").SandboxStatus = "RUNNING") {
  const railway = await import("railway");
  const files = new Map<string, string>();
  const commands: string[] = [];

  const vm = partialSdkFixture<import("railway").Sandbox>({
    id: "railway-vm",
    status,
    createdAt: "2026-09-01T00:00:00.000Z",
  });

  // `files.read` and `exec` are overloaded, which the typed fixture cannot express; the
  // adapter and Akeru use only the string-path and plain-command forms supplied here.
  Object.assign(vm, {
    files: {
      read: vi.fn(async (path: string) => {
        const content = files.get(path);

        if (content === undefined)
          throw Object.assign(new Error(`${path} missing`), { name: "SandboxFileNotFoundError" });

        return content;
      }),
    },
    exec: vi.fn(async (command: string) => {
      commands.push(command);

      if (command === "pwd") return { exitCode: 0, stdout: "/root\n", stderr: "" };
      const written = /printf %s '(.+)' > '(\/tmp\/\.sandbox-sdk\/railway\.json)'/.exec(command);

      if (written?.[1] && written[2] && !files.has(written[2])) files.set(written[2], written[1]);

      return { exitCode: 0, stdout: "", stderr: "" };
    }),
  });

  const connect = vi.spyOn(railway.Sandbox, "connect").mockResolvedValue(vm);

  return { files, commands, connect };
}

/**
 * A paused Upstash box the old adapter made: no SDK metadata. Its fake shell serves the SDK's
 * metadata read, Akeru's guarded metadata write (or fails it), and `pwd`.
 */
async function legacyUpstashBox(
  options: {
    readonly failMetadataWrite?: boolean;
    readonly workdir?: string;
    /** Commands on a paused box resume it, as Upstash does on use. */
    readonly resumeOnCommand?: boolean;
  } = {},
) {
  const sdk = await import("@upstash/box");
  let metadata: string | undefined;
  let status: import("@upstash/box").BoxData["status"] = "paused";

  const resume = vi.fn(async () => {
    status = "running";
  });

  const pause = vi.fn(async () => {
    status = "paused";
  });

  const command = vi.fn(async (line: string) => {
    if (options.resumeOnCommand && status === "paused") status = "running";
    const reply = (exitCode: number, stdout: string) => ({ exitCode, stdout, result: stdout });

    if (line === "pwd") return reply(0, `${options.workdir ?? "/workspace/home"}\n`);

    if (line.includes("cat '/tmp/.sandbox-sdk/upstash.json'"))
      return metadata === undefined ? reply(1, "") : reply(0, metadata);
    const written = /printf %s '(.+)' > '\/tmp\/\.sandbox-sdk\/upstash\.json'/.exec(line);

    if (written?.[1] && options.failMetadataWrite) return reply(1, "");

    if (written?.[1] && metadata === undefined) metadata = written[1];

    return reply(0, "");
  });

  const box = partialSdkFixture<import("@upstash/box").Box>({
    id: "upstash-box",
    resume,
    pause,
    exec: { command },
  });

  vi.spyOn(sdk.Box, "list").mockImplementation(async () => [
    partialSdkFixture<import("@upstash/box").BoxData>({
      id: "upstash-box",
      status,
      created_at: 1_700_000_000,
    }),
  ]);
  vi.spyOn(sdk.Box, "get").mockResolvedValue(box);

  return { resume, pause, command, metadata: () => metadata };
}

describe("adopting sandboxes the old adapters created", () => {
  it("reconnects a Railway VM that has no Sandbox SDK metadata", async () => {
    const { files, commands, connect } = await legacyRailwayVm();
    const file = identityFile();
    legacyIdentity(file, "railway", "railway-vm");

    const workspace = await createRemoteBotWorkspace(reattachInput(file, "railway"));

    expect(workspace.providerId).toBe("railway-vm");
    expect(connect).toHaveBeenCalledWith("railway-vm", {
      token: "token",
      environmentId: "environment",
    });
    expect(JSON.parse(files.get("/tmp/.sandbox-sdk/railway.json") ?? "")).toEqual({
      version: 1,
      labels: { "sandbox-sdk": "1" },
    });
    expect(commands.find((command) => command.includes("railway.json"))).toContain("[ -e ");
    expect(saved(file)).toEqual({
      provider: "railway",
      providerId: "railway-vm",
      workdir: "/root",
    });
    await expect(workspace.inspect()).resolves.toBe("running");

    // Losing the marker later (a cleared /tmp) is not losing the VM.
    files.clear();
    await expect(workspace.inspect()).resolves.toBe("running");
    expect(files.has("/tmp/.sandbox-sdk/railway.json")).toBe(true);
  });

  it("never overwrites metadata a Railway VM already has", async () => {
    const { files } = await legacyRailwayVm();
    const own = JSON.stringify({ version: 1, key: "theirs", labels: { "sandbox-sdk": "1" } });
    files.set("/tmp/.sandbox-sdk/railway.json", own);
    const file = identityFile();
    legacyIdentity(file, "railway", "railway-vm");

    await createRemoteBotWorkspace(reattachInput(file, "railway"));
    expect(files.get("/tmp/.sandbox-sdk/railway.json")).toBe(own);
  });

  it("fails closed and keeps the saved ID when Railway says the VM is destroyed", async () => {
    await legacyRailwayVm("DESTROYED");
    const file = identityFile();
    legacyIdentity(file, "railway", "railway-vm");

    await expect(createRemoteBotWorkspace(reattachInput(file, "railway"))).rejects.toThrow(
      `Remove '${file}' to create a replacement`,
    );
    expect(saved(file).providerId).toBe("railway-vm");
  });

  it("reconnects an Upstash box that has no Sandbox SDK metadata, resuming it first", async () => {
    const upstash = await legacyUpstashBox();
    const file = identityFile();
    legacyIdentity(file, "upstash", "upstash-box");

    const workspace = await createRemoteBotWorkspace(reattachInput(file, "upstash"));

    expect(upstash.resume).toHaveBeenCalledOnce();
    expect(upstash.pause).not.toHaveBeenCalled();
    expect(JSON.parse(upstash.metadata() ?? "")).toEqual({
      version: 1,
      labels: { "sandbox-sdk": "1" },
    });
    expect(
      upstash.command.mock.calls.some(([line]) =>
        line.startsWith('[ -n "$SANDBOX_SDK_UPSTASH_METADATA" ] ||'),
      ),
    ).toBe(true);
    expect(saved(file)).toEqual({
      provider: "upstash",
      providerId: "upstash-box",
      workdir: "/workspace/home",
    });
    await expect(workspace.inspect()).resolves.toBe("running");
  });

  it("pauses an Upstash box that the SDK's metadata command woke, when reattach then fails", async () => {
    // Connect reads metadata with a command, which wakes the paused box before adoption
    // looks at it; adoption then sees a running box, and its metadata write fails.
    const upstash = await legacyUpstashBox({ failMetadataWrite: true, resumeOnCommand: true });
    const file = identityFile();
    legacyIdentity(file, "upstash", "upstash-box");

    await expect(createRemoteBotWorkspace(reattachInput(file, "upstash"))).rejects.toThrow(
      "missing or unavailable",
    );
    expect(upstash.resume).not.toHaveBeenCalled();
    expect(upstash.pause).toHaveBeenCalledOnce();
    expect(saved(file)).toEqual({ provider: "upstash", providerId: "upstash-box" });
  });

  it.each(["the metadata write", "the working-directory probe", "saving the identity"] as const)(
    "pauses an Upstash box it resumed when %s fails, and keeps the identity",
    async (step) => {
      const upstash = await legacyUpstashBox({
        failMetadataWrite: step === "the metadata write",
        workdir: step === "the working-directory probe" ? "" : "/workspace/home",
      });

      const file = identityFile();
      legacyIdentity(file, "upstash", "upstash-box");

      const io =
        step === "saving the identity"
          ? { ...workspaceIO, writeIdentity: () => Promise.reject(new Error("disk full")) }
          : workspaceIO;

      await expect(
        createRemoteBotWorkspace({ ...reattachInput(file, "upstash"), io }),
      ).rejects.toThrow("missing or unavailable");
      expect(upstash.resume).toHaveBeenCalledOnce();
      expect(upstash.pause).toHaveBeenCalledOnce();
      expect(saved(file)).toEqual({ provider: "upstash", providerId: "upstash-box" });
    },
  );

  it("reports unreadable metadata on an existing sandbox as unavailable, never as gone", async () => {
    const missing = new SandboxError("Invalid SDK metadata", { code: "not_found" });

    await expect(
      withAdoption(
        async () => true,
        "box",
        () => Promise.reject(missing),
      ),
    ).rejects.toMatchObject({ code: "unavailable", sandboxId: "box" });
    await expect(
      withAdoption(
        async () => false,
        "box",
        () => Promise.reject(missing),
      ),
    ).rejects.toBe(missing);
  });
});
