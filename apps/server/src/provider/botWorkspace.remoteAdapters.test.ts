import { describe } from "vite-plus/test";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it, vi } from "vite-plus/test";
import {
  createRemoteBotWorkspace,
  daytona,
  e2b,
  railway,
  railwayWorkspaceState,
  upstash,
  upstashWorkspaceState,
  vercel,
  vercelWorkspaceState,
} from "./botWorkspace.ts";

describe("createBotWorkspace", () => {
  it("creates and reattaches Railway identities with explicit credentials and cleans up", async () => {
    const { Sandbox } = await import("railway");
    const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-railway-"));
    const identityFile = NodePath.join(baseDir, "identity.json");
    const destroy = vi.fn(async () => undefined);

    const sandbox = {
      id: "railway-id",
      status: "RUNNING",
      refresh: vi.fn(async () => undefined),
      destroy,
    } as unknown as import("railway").Sandbox;

    const create = vi.spyOn(Sandbox, "create").mockResolvedValue(sandbox);
    const connect = vi.spyOn(Sandbox, "connect").mockResolvedValue(sandbox);

    const input = {
      threadId: "railway-thread",
      workspaceId: "akeru-railway",
      identityFile,
      sandbox: "railway" as const,
      environment: { RAILWAY_API_TOKEN: " token ", RAILWAY_ENVIRONMENT_ID: " env " },
    };

    try {
      const first = await createRemoteBotWorkspace(input);
      await first.wake();
      await first.sleep();
      expect(destroy).not.toHaveBeenCalled();
      const second = await createRemoteBotWorkspace(input);
      expect(second.providerId).toBe("railway-id");
      expect(create).toHaveBeenCalledExactlyOnceWith({ token: "token", environmentId: "env" });
      expect(connect).toHaveBeenCalledWith("railway-id", { token: "token", environmentId: "env" });
      connect.mockRejectedValueOnce(new Error("unavailable"));
      await expect(createRemoteBotWorkspace(input)).rejects.toThrow("missing or unavailable");
      expect(create).toHaveBeenCalledTimes(1);
      await second.wake();
      await second.destroy();
      expect(destroy).toHaveBeenCalledOnce();
      expect(NodeFS.existsSync(identityFile)).toBe(false);

      for (const environment of [{}, { RAILWAY_API_TOKEN: "token" }]) {
        await expect(createRemoteBotWorkspace({ ...input, environment })).rejects.toThrow(
          "Remote sandbox credential",
        );
      }

      expect(create).toHaveBeenCalledTimes(1);
    } finally {
      create.mockRestore();
      connect.mockRestore();
      NodeFS.rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("executes Railway commands and refuses automatic browser ingress", async () => {
    const exec = vi.fn(
      async (): Promise<{ exitCode: number | null; stdout: string; stderr: string }> => ({
        exitCode: 7,
        stdout: "output",
        stderr: "error",
      }),
    );

    const refresh = vi.fn(async () => undefined);
    const sandbox = { id: "railway-id", status: "RUNNING", exec, refresh };
    const session = railway(sandbox as unknown as import("railway").Sandbox);
    expect(
      await session.run("echo", ["it's private"], {
        cwd: "/tmp",
        env: { HELLO: "world" },
        timeout: 1501,
      }),
    ).toEqual({ exitCode: 7, stdout: "output", stderr: "error" });
    expect(exec).toHaveBeenCalledWith("'echo' 'it'\\''s private'", {
      cwd: "/tmp",
      env: { HELLO: "world" },
      timeoutSec: 2,
    });
    await expect(session.browserEndpoint(9223)).rejects.toThrow("Railway CLI tunnel");
    exec.mockResolvedValueOnce({ exitCode: null, stdout: "partial", stderr: "terminated" });
    await expect(session.run("false", [])).resolves.toEqual({
      exitCode: 1,
      stdout: "partial",
      stderr: "terminated",
    });
    await expect(session.inspect()).resolves.toBe("running");
    sandbox.status = "DESTROYED";
    await expect(session.wake()).rejects.toThrow("not running");
    const { SandboxNotFoundError } = await import("railway");
    refresh.mockRejectedValueOnce(
      new SandboxNotFoundError({ id: "railway-id", environmentId: "env" }),
    );
    await expect(session.inspect()).resolves.toBe("missing");
    refresh.mockRejectedValueOnce(new Error("unauthorized"));
    await expect(session.inspect()).rejects.toThrow("unauthorized");
    expect(railwayWorkspaceState("CREATING")).toBe("sleeping");

    for (const status of ["DESTROYING", "DESTROYED", "FAILED"] as const) {
      expect(railwayWorkspaceState(status)).toBe("missing");
    }
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
