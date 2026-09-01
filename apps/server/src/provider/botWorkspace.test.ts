// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { LocalFilesystem, LocalSandbox, Workspace } from "@mastra/core/workspace";
import { assert, describe, expect, it, vi } from "vite-plus/test";

import {
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
    for (const sandbox of ["e2b", "daytona", "vercel", "upstash"] as const) {
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
