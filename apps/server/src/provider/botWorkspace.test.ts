// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { LocalFilesystem, LocalSandbox, Workspace } from "@mastra/core/workspace";
import { DateTime } from "effect";
import { assert, describe, expect, it, vi } from "vite-plus/test";

import {
  ascii,
  createBotWorkspace,
  createRemoteBotWorkspace,
  daytona,
  e2b,
  type AkeruRemoteSession,
  isRemoteBotSandbox,
  upstash,
  upstashWorkspaceState,
  vercel,
  vercelWorkspaceState,
} from "./botWorkspace.ts";

describe("Ascii Box", () => {
  const deleted = {
    ok: true,
    type: "box.deleting",
    operation: {
      id: "deletion",
      kind: "box",
      targetId: "ascii-id",
      reason: "explicit",
      status: "completed",
      attemptCount: 0,
      requestedAt: DateTime.toDate(DateTime.makeUnsafe(0)),
      completedAt: null,
    },
  } satisfies import("@asciidev/box-sdk").DeletionOperationResponse;
  async function setup() {
    const { BoxApi, Configuration } = await import("@asciidev/box-sdk");
    const client = new BoxApi(new Configuration({ accessToken: "test-key" }));
    const get = vi.spyOn(client, "get").mockResolvedValue({
      type: "box.info",
      box: {
        id: "ascii-id",
        name: "test",
        state: "idle",
        desktopAvailable: false,
        snapshotAvailable: true,
      },
      ok: true,
    });
    return { client, get, session: ascii(client, "ascii-id") };
  }

  it("waits for pending VM deletion to complete", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "performance"] });
    try {
      const { client, session } = await setup();
      const pending = {
        ...deleted,
        operation: { ...deleted.operation, status: "pending" as const },
      };
      vi.spyOn(client, "deleteBox").mockResolvedValue(pending);
      const poll = vi
        .spyOn(client, "getDeletionOperation")
        .mockResolvedValueOnce(pending)
        .mockResolvedValue(deleted);
      let complete = false;
      const operation = session.destroy().then(() => {
        complete = true;
      });
      await vi.advanceTimersByTimeAsync(2_000);
      expect(complete).toBe(false);
      await vi.advanceTimersByTimeAsync(2_000);
      await operation;
      expect(poll).toHaveBeenCalledWith({ operationId: "deletion" });
      expect(complete).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds pending deletion waits", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "performance"] });
    try {
      const { client, session } = await setup();
      const pending = {
        ...deleted,
        operation: { ...deleted.operation, status: "pending" as const },
      };
      vi.spyOn(client, "deleteBox").mockResolvedValue(pending);
      vi.spyOn(client, "getDeletionOperation").mockResolvedValue(pending);
      const failure = expect(session.destroy()).rejects.toThrow("deletion timed out");
      await vi.advanceTimersByTimeAsync(300_000);
      await failure;
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops with a native snapshot, resumes, and deletes with confirmation", async () => {
    const { client, get, session } = await setup();
    const stop = vi
      .spyOn(client, "stop")
      .mockResolvedValue({ ok: true, type: "box.stopped", id: "ascii-id", status: "archived" });
    const resume = vi
      .spyOn(client, "resume")
      .mockResolvedValue({ ok: true, type: "box.resumed", id: "ascii-id", status: "ready" });
    const remove = vi.spyOn(client, "deleteBox").mockResolvedValue(deleted);
    const current = await client.get({ boxId: "ascii-id" });
    get.mockResolvedValueOnce({ ...current, box: { ...current.box, state: "archived" } });
    await session.sleep();
    expect(stop).toHaveBeenCalledWith({ boxId: "ascii-id" });
    get.mockResolvedValueOnce({ ...current, box: { ...current.box, state: "archived" } });
    await session.wake();
    expect(resume).toHaveBeenCalledWith({ boxId: "ascii-id", resumeRequest: { ttlSeconds: null } });
    expect(await session.inspect()).toBe("running");
    await session.destroy();
    expect(remove).toHaveBeenCalledWith({ boxId: "ascii-id", xAsciiConfirmDelete: "ascii-id" });
  });

  it.each(["sleep", "wake"] as const)(
    "waits for native snapshot completion during %s",
    async (action) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "performance"] });
      try {
        const { client, get, session } = await setup();
        const current = await client.get({ boxId: "ascii-id" });
        const archiving = { ...current, box: { ...current.box, state: "archiving" as const } };
        const archived = { ...current, box: { ...current.box, state: "archived" as const } };
        const stop = vi.spyOn(client, "stop").mockResolvedValue({
          ok: true,
          type: "box.stopped",
          id: "ascii-id",
          status: "archiving",
        });
        const resume = vi
          .spyOn(client, "resume")
          .mockResolvedValue({ ok: true, type: "box.resumed", id: "ascii-id", status: "ready" });
        if (action === "wake") get.mockResolvedValueOnce(archiving);
        get.mockResolvedValueOnce(archiving).mockResolvedValueOnce(archived);
        let completed = false;
        const operation = session[action]().then(() => {
          completed = true;
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(completed).toBe(false);
        expect(resume).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(2_000);
        await operation;
        if (action === "wake")
          expect(resume).toHaveBeenCalledWith({
            boxId: "ascii-id",
            resumeRequest: { ttlSeconds: null },
          });
        else expect(stop).toHaveBeenCalledOnce();
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("surfaces snapshot errors without force-stopping or deleting the VM", async () => {
    const { client, get, session } = await setup();
    const current = await client.get({ boxId: "ascii-id" });
    get.mockResolvedValue({ ...current, box: { ...current.box, state: "error" } });
    const stop = vi
      .spyOn(client, "stop")
      .mockResolvedValue({ ok: true, type: "box.stopped", id: "ascii-id", status: "archiving" });
    const remove = vi.spyOn(client, "deleteBox");
    await expect(session.sleep()).rejects.toThrow("snapshot archival failed");
    expect(stop).toHaveBeenCalledWith({ boxId: "ascii-id" });
    expect(remove).not.toHaveBeenCalled();
  });

  it("bounds snapshot waits without deleting the VM", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "performance"] });
    try {
      const { client, get, session } = await setup();
      const current = await client.get({ boxId: "ascii-id" });
      get.mockResolvedValue({ ...current, box: { ...current.box, state: "archiving" } });
      const resume = vi.spyOn(client, "resume");
      const remove = vi.spyOn(client, "deleteBox");
      const failure = expect(session.wake()).rejects.toThrow("snapshot archival timed out");
      await vi.advanceTimersByTimeAsync(300_000);
      await failure;
      expect(resume).not.toHaveBeenCalled();
      expect(remove).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    "init",
    "provisioning",
    "provisioned",
    "cloning",
    "archiving",
    "archived",
    "error",
  ] as const)("does not report %s VMs as running", async (state) => {
    const { client, get, session } = await setup();
    const current = await client.get({ boxId: "ascii-id" });
    get.mockResolvedValue({ ...current, box: { ...current.box, state } });
    expect(await session.inspect()).toBe(state === "error" ? "missing" : "sleeping");
  });

  it("distinguishes missing VMs from credential or transport errors", async () => {
    const { ResponseError } = await import("@asciidev/box-sdk");
    const { get, session } = await setup();
    get.mockRejectedValue(new ResponseError(new Response(null, { status: 404 })));
    expect(await session.inspect()).toBe("missing");
    get.mockRejectedValue(new Error("unauthorized"));
    await expect(session.inspect()).rejects.toThrow("unauthorized");
  });

  it("quotes commands, absolute working directories and environment values", async () => {
    const { client, session } = await setup();
    const command = vi.spyOn(client, "command").mockResolvedValue({
      ok: true,
      type: "command.finished",
      success: false,
      exitCode: 7,
      stdout: "out",
      stderr: "err",
      timedOut: false,
    });
    expect(
      await session.run("printf", ["a'b"], {
        cwd: "/workspace/my files",
        env: { VALUE: "x; echo unsafe" },
        timeout: 1501,
      }),
    ).toEqual({ exitCode: 7, stdout: "out", stderr: "err" });
    expect(command).toHaveBeenCalledWith({
      boxId: "ascii-id",
      commandRequest: {
        command: "cd '/workspace/my files' && env 'VALUE=x; echo unsafe' 'printf' 'a'\\''b'",
        timeoutSeconds: 2,
      },
    });
    command.mockResolvedValue({
      ok: true,
      type: "command.finished",
      success: false,
      exitCode: null,
      stdout: "",
      stderr: "",
      timedOut: true,
    });
    expect((await session.run("sleep", ["2"])).exitCode).toBe(124);
    expect(command).toHaveBeenLastCalledWith({
      boxId: "ascii-id",
      commandRequest: { command: "'sleep' '2'", timeoutSeconds: 600 },
    });
    await session.run("sleep", ["2"], { timeout: 900_000 });
    expect(command).toHaveBeenLastCalledWith({
      boxId: "ascii-id",
      commandRequest: { command: "'sleep' '2'", timeoutSeconds: 600 },
    });
  });

  it("protects browser control without forwarding the API credential", async () => {
    const { client, session } = await setup();
    const hostPort = vi.spyOn(client, "hostPort").mockResolvedValue({
      ok: true,
      type: "host_port",
      url: "https://preview.example/?_token=browser-token",
      isProtected: true,
    });
    expect(await session.browserEndpoint(9223)).toEqual({
      url: "https://preview.example/?_token=browser-token",
      requestHeaders: {},
    });
    expect(hostPort).toHaveBeenCalledWith({
      boxId: "ascii-id",
      hostPortRequest: { port: 9223, _public: false },
    });
    hostPort.mockResolvedValue({ ok: true, type: "host_port" });
    await expect(session.browserEndpoint(9223)).rejects.toThrow("preview URL");
    hostPort.mockResolvedValue({
      ok: true,
      type: "host_port",
      url: "https://preview.example",
      isProtected: false,
    });
    await expect(session.browserEndpoint(9223)).rejects.toThrow("protected browser endpoint");
    hostPort.mockResolvedValue({
      ok: true,
      type: "host_port",
      url: "https://preview.example",
      isProtected: true,
    });
    await expect(session.browserEndpoint(9223)).rejects.toThrow("protected browser endpoint");
  });

  it("creates once with the configured credential and reattaches by saved VM identity", async () => {
    const { BoxApi } = await import("@asciidev/box-sdk");
    const root = await NodeFS.promises.mkdtemp(NodePath.join(NodeOS.tmpdir(), "akeru-ascii-"));
    const box = {
      id: "ascii-id",
      name: "test",
      state: "idle" as const,
      desktopAvailable: false,
      snapshotAvailable: true,
    };
    const create = vi.spyOn(BoxApi.prototype, "create").mockResolvedValue({
      ok: true,
      type: "box.created",
      status: "provisioning",
      ttlSeconds: null,
      box,
    });
    const get = vi
      .spyOn(BoxApi.prototype, "get")
      .mockResolvedValue({ ok: true, type: "box.info", box });
    const remove = vi.spyOn(BoxApi.prototype, "deleteBox").mockResolvedValue(deleted);
    const command = vi.spyOn(BoxApi.prototype, "command").mockResolvedValue({
      ok: true,
      type: "command.finished",
      success: true,
      exitCode: 0,
      stdout: "",
      stderr: "",
      timedOut: false,
    });
    try {
      const input = {
        threadId: "thread",
        sandbox: "ascii" as const,
        workspaceId: "workspace",
        identityFile: NodePath.join(root, "identity.json"),
        environment: { BOX_API_KEY: "configured-key" },
      };
      const first = await createRemoteBotWorkspace(input);
      expect(create).toHaveBeenCalledWith({ createBoxRequest: { ttlSeconds: null, noEnv: true } });
      const client = create.mock.contexts[0] as import("@asciidev/box-sdk").BoxApi;
      expect((await client.createRequestOpts({})).headers.Authorization).toBe(
        "Bearer configured-key",
      );
      expect(first.providerId).toBe("ascii-id");
      get.mockRejectedValueOnce(new Error("VM unavailable"));
      await expect(createRemoteBotWorkspace(input)).rejects.toThrow("missing or unavailable");
      expect(create).toHaveBeenCalledOnce();
      const second = await createRemoteBotWorkspace(input);
      expect(create).toHaveBeenCalledOnce();
      expect(get).toHaveBeenCalledWith({ boxId: "ascii-id" });
      await second.wake();
      remove.mockResolvedValueOnce({
        ...deleted,
        operation: { ...deleted.operation, status: "blocked" },
      });
      await expect(second.destroy()).rejects.toThrow("deletion is blocked");
      expect(JSON.parse(await NodeFS.promises.readFile(input.identityFile, "utf8"))).toEqual({
        provider: "ascii",
        providerId: "ascii-id",
      });
      await second.destroy();
      expect(remove).toHaveBeenCalledTimes(2);
      await expect(NodeFS.promises.stat(input.identityFile)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      create.mockRestore();
      get.mockRestore();
      remove.mockRestore();
      command.mockRestore();
      await NodeFS.promises.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a missing credential before creating a VM", async () => {
    const { BoxApi } = await import("@asciidev/box-sdk");
    const create = vi.spyOn(BoxApi.prototype, "create");
    const root = await NodeFS.promises.mkdtemp(NodePath.join(NodeOS.tmpdir(), "akeru-ascii-"));
    try {
      await expect(
        createRemoteBotWorkspace({
          threadId: "thread",
          sandbox: "ascii",
          workspaceId: "workspace",
          identityFile: NodePath.join(root, "identity.json"),
          environment: {},
        }),
      ).rejects.toThrow("BOX_API_KEY");
      expect(create).not.toHaveBeenCalled();
    } finally {
      create.mockRestore();
      await NodeFS.promises.rm(root, { recursive: true, force: true });
    }
  });
});

function remoteSession(providerId: string): AkeruRemoteSession {
  return {
    providerId,
    inspect: async () => "running",
    run: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    browserEndpoint: async () => ({ url: "https://browser.example", requestHeaders: {} }),
    wake: async () => undefined,
    sleep: async () => undefined,
    destroy: async () => undefined,
  };
}

describe("createBotWorkspace", () => {
  it("classifies every managed provider", () => {
    expect(isRemoteBotSandbox("local")).toBe(false);
    for (const sandbox of ["e2b", "daytona", "vercel", "upstash", "ascii"] as const) {
      expect(isRemoteBotSandbox(sandbox)).toBe(true);
    }
  });

  it("keeps durable local bot files outside the user project", async () => {
    const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-workspace-"));
    const projectDir = NodePath.join(baseDir, "project");
    const botRoot = NodePath.join(baseDir, "state", "akeru-bot-one");
    NodeFS.mkdirSync(projectDir, { recursive: true });
    const workspace = await createBotWorkspace({
      threadId: "bot-one",
      cwd: projectDir,
      localRoot: botRoot,
      workspaceId: "akeru-bot-one",
      sandbox: "local",
    });
    assert.isDefined(workspace);
    expect(workspace.workspace.sandbox).toBeInstanceOf(LocalSandbox);
    expect(workspace.workspace.filesystem).toBeInstanceOf(LocalFilesystem);
    await workspace.workspace.filesystem?.writeFile("identity.txt", "bot-owned");
    expect(NodeFS.readFileSync(NodePath.join(botRoot, "identity.txt"), "utf8")).toBe("bot-owned");
    expect(NodeFS.existsSync(NodePath.join(projectDir, "identity.txt"))).toBe(false);
    await workspace.destroy();
    NodeFS.rmSync(baseDir, { recursive: true, force: true });
  });

  it("passes stable identity to an injected remote provider", async () => {
    const remote = new Workspace({
      filesystem: new LocalFilesystem({ basePath: process.cwd() }),
      sandbox: new LocalSandbox({ workingDirectory: process.cwd() }),
    });
    const makeRemoteWorkspace = vi.fn(async () => remote);
    await createBotWorkspace({
      threadId: "thread-vercel",
      sandbox: "vercel",
      workspaceId: "akeru-vercel",
      environment: {
        VERCEL_TOKEN: "token",
        VERCEL_TEAM_ID: "team",
        VERCEL_PROJECT_ID: "project",
      },
      makeRemoteWorkspace,
    });
    expect(makeRemoteWorkspace).toHaveBeenCalledWith({
      threadId: "thread-vercel",
      sandbox: "vercel",
      workspaceId: "akeru-vercel",
      environment: {
        VERCEL_TOKEN: "token",
        VERCEL_TEAM_ID: "team",
        VERCEL_PROJECT_ID: "project",
      },
    });
    await remote.destroy();
  });

  it("requires stable identity for remote workspaces", async () => {
    await expect(
      createRemoteBotWorkspace({ threadId: "thread-remote", sandbox: "e2b" }),
    ).rejects.toThrow("needs a stable workspace identity");
  });

  it("persists the provider identity and uses it to reattach", async () => {
    const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-identity-"));
    const identityFile = NodePath.join(baseDir, "provider.json");
    const openSession = vi.fn(async (providerId?: string) =>
      remoteSession(providerId ?? "native-workspace-id"),
    );
    const input = {
      threadId: "thread-remote",
      sandbox: "e2b" as const,
      workspaceId: "akeru-stable-id",
      identityFile,
      openSession,
    };

    const created = await createRemoteBotWorkspace(input);
    const reattached = await createRemoteBotWorkspace(input);

    expect(created.id).toBe("akeru-stable-id");
    expect(reattached.id).toBe("akeru-stable-id");
    expect(reattached.providerId).toBe("native-workspace-id");
    expect(openSession).toHaveBeenNthCalledWith(1, undefined);
    expect(openSession).toHaveBeenNthCalledWith(2, "native-workspace-id");
    expect(JSON.parse(NodeFS.readFileSync(identityFile, "utf8"))).toEqual({
      provider: "e2b",
      providerId: "native-workspace-id",
    });
    await reattached.destroy();
    expect(NodeFS.existsSync(identityFile)).toBe(false);
    NodeFS.rmSync(baseDir, { recursive: true, force: true });
  });

  it("fails closed when a persisted remote workspace is missing", async () => {
    const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-missing-"));
    const identityFile = NodePath.join(baseDir, "provider.json");
    NodeFS.writeFileSync(
      identityFile,
      `${JSON.stringify({ provider: "vercel", providerId: "missing-id" })}\n`,
    );

    await expect(
      createRemoteBotWorkspace({
        threadId: "thread-remote",
        sandbox: "vercel",
        workspaceId: "akeru-stable-id",
        identityFile,
        openSession: async () => Promise.reject(new Error("not found")),
      }),
    ).rejects.toThrow(`Remove '${identityFile}' to create a replacement`);
    expect(NodeFS.existsSync(identityFile)).toBe(true);
    NodeFS.rmSync(baseDir, { recursive: true, force: true });
  });

  it("pauses and restarts Daytona workspaces", async () => {
    let state = "started";
    const pause = vi.fn(async () => {
      state = "paused";
    });
    const start = vi.fn(async () => {
      state = "started";
    });
    const sandbox = {
      id: "daytona-id",
      get state() {
        return state;
      },
      refreshData: vi.fn(async () => undefined),
      pause,
      start,
      delete: vi.fn(async () => undefined),
      getPreviewLink: vi.fn(async () => ({
        url: "https://9223-daytona.example",
        token: "daytona-token",
      })),
      process: { executeCommand: vi.fn() },
    } as unknown as import("@daytona/sdk").Sandbox;
    const client = {
      [Symbol.asyncDispose]: vi.fn(async () => undefined),
    } as unknown as import("@daytona/sdk").Daytona;
    const session = daytona(client, sandbox);

    await session.sleep();
    expect(await session.inspect()).toBe("sleeping");
    await session.wake();

    expect(pause).toHaveBeenCalledOnce();
    expect(start).toHaveBeenCalledOnce();
    expect(await session.inspect()).toBe("running");
    await expect(session.browserEndpoint(9223)).resolves.toEqual({
      url: "https://9223-daytona.example/?DAYTONA_SANDBOX_AUTH_KEY=daytona-token",
      requestHeaders: {},
    });
  });

  it("keeps E2B browser ingress private", async () => {
    const session = e2b({
      sandboxId: "e2b-id",
      trafficAccessToken: "e2b-token",
      getHost: (port: number) => `${port}-e2b.example`,
      commands: { run: vi.fn() },
      pause: vi.fn(),
      kill: vi.fn(),
    } as unknown as import("e2b").Sandbox);

    await expect(session.browserEndpoint(9223)).resolves.toEqual({
      url: "https://9223-e2b.example",
      requestHeaders: { "e2b-traffic-access-token": "e2b-token" },
    });
  });

  it("adds the Vercel browser port without removing existing routes", async () => {
    const update = vi.fn(async () => undefined);
    const session = vercel({
      name: "vercel-id",
      status: "running",
      routes: [{ port: 3000 }],
      update,
      domain: (port: number) => `https://${port}-vercel.example`,
      runCommand: vi.fn(),
      stop: vi.fn(),
      delete: vi.fn(),
    } as unknown as import("@vercel/sandbox").Sandbox);

    await expect(session.browserEndpoint(9223)).resolves.toEqual({
      url: "https://9223-vercel.example",
      requestHeaders: {},
    });
    expect(update).toHaveBeenCalledWith({ ports: [3000, 9223] });
  });

  it("resumes a paused Upstash workspace after reattach", async () => {
    let status = "paused";
    const resume = vi.fn(async () => {
      status = "running";
    });
    const box = {
      id: "upstash-id",
      getStatus: vi.fn(async () => ({ status })),
      resume,
      pause: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
      getPublicURL: vi.fn(async () => ({
        url: "https://9223-upstash.example",
        port: 9223,
        token: "upstash-token",
      })),
      exec: { command: vi.fn() },
    } as unknown as import("@upstash/box").Box;
    const session = upstash(box);

    await session.wake();

    expect(resume).toHaveBeenCalledOnce();
    expect(await session.inspect()).toBe("running");
    await expect(session.browserEndpoint(9223)).resolves.toEqual({
      url: "https://9223-upstash.example",
      requestHeaders: { authorization: "Bearer upstash-token" },
    });
  });

  it("fails closed when a remote provider omits browser credentials", async () => {
    const e2bSession = e2b({
      sandboxId: "e2b-id",
      getHost: vi.fn(),
      commands: { run: vi.fn() },
      pause: vi.fn(),
      kill: vi.fn(),
    } as unknown as import("e2b").Sandbox);
    const upstashSession = upstash({
      id: "upstash-id",
      getPublicURL: vi.fn(async () => ({ url: "https://upstash.example", port: 9223 })),
    } as unknown as import("@upstash/box").Box);
    const daytonaSession = daytona(
      {} as import("@daytona/sdk").Daytona,
      {
        id: "daytona-id",
        getPreviewLink: vi.fn(async () => ({
          url: "https://daytona.example",
          token: "",
        })),
      } as unknown as import("@daytona/sdk").Sandbox,
    );

    await expect(e2bSession.browserEndpoint(9223)).rejects.toThrow("no traffic access token");
    await expect(daytonaSession.browserEndpoint(9223)).rejects.toThrow(
      "no authenticated preview URL",
    );
    await expect(upstashSession.browserEndpoint(9223)).rejects.toThrow(
      "no authenticated public URL",
    );
  });

  it("does not classify unavailable provider states as running", () => {
    expect(upstashWorkspaceState("creating")).toBe("sleeping");
    expect(upstashWorkspaceState("error")).toBe("missing");
    expect(upstashWorkspaceState("deleted")).toBe("missing");
    expect(vercelWorkspaceState("failed")).toBe("missing");
    expect(vercelWorkspaceState("aborted")).toBe("missing");
    expect(vercelWorkspaceState("stopped")).toBe("sleeping");
  });
});
