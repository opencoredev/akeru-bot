// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type { Session, SessionState } from "@tenkicloud/sandbox";
import { describe, expect, it, vi } from "vite-plus/test";
import { createRemoteBotWorkspace, tenki, tenkiWorkspaceState } from "./botWorkspace.ts";
import { BotWorkspacePool } from "./botWorkspacePool.ts";

const sdk = vi.hoisted(() => ({ create: vi.fn(), get: vi.fn(), constructor: vi.fn() }));
vi.mock("@tenkicloud/sandbox", () => ({
  TenkiSandbox: class {
    constructor(options: unknown) {
      sdk.constructor(options);
    }
    create = sdk.create;
    get = sdk.get;
  },
}));

function mockSession(state: SessionState = "RUNNING") {
  const session = {
    id: "tenki-session",
    state,
    refresh: vi.fn(async () => {}),
    pause: vi.fn(async () => {
      session.state = "PAUSING";
    }),
    waitPaused: vi.fn(async () => {
      session.state = "PAUSED";
    }),
    resume: vi.fn(async () => {
      session.state = "RESUMING";
    }),
    waitResumed: vi.fn(async () => {
      session.state = "RUNNING";
    }),
    waitReady: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    exposePort: vi.fn(async () => ({ previewUrl: "https://preview.example.test" })),
    exec: vi.fn(async () => ({
      stdout: new TextEncoder().encode("hello 世界"),
      stderr: new TextEncoder().encode("command failed"),
      exitCode: 7,
    })),
  };
  return { session, adapter: tenki(session as unknown as Session) };
}

describe("Tenki workspace", () => {
  it("creates a sticky VM, reattaches its saved identity, and deletes it only on destroy", async () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-tenki-"));
    const identityFile = NodePath.join(root, "identity.json");
    const { session } = mockSession();
    sdk.create.mockClear().mockResolvedValue(session);
    sdk.get.mockClear().mockResolvedValue(session);
    const input = {
      sandbox: "tenki" as const,
      threadId: "thread-tenki",
      workspaceId: "bot-tenki",
      identityFile,
      environment: { TENKI_API_KEY: " test-key " },
    };
    try {
      const first = await createRemoteBotWorkspace(input);
      expect(sdk.constructor).toHaveBeenLastCalledWith({ apiKey: "test-key" });
      expect(sdk.create).toHaveBeenCalledExactlyOnceWith({
        name: "bot-tenki",
        sticky: true,
        waitReady: false,
      });
      await first.sleep();
      expect(session.close).not.toHaveBeenCalled();
      const second = await createRemoteBotWorkspace(input);
      expect(sdk.get).toHaveBeenCalledExactlyOnceWith("tenki-session");
      expect(sdk.create).toHaveBeenCalledTimes(1);
      await second.wake();
      expect(session.resume).toHaveBeenCalledOnce();
      expect(await second.inspect()).toBe("running");
      await second.destroy();
      expect(session.close).toHaveBeenCalledOnce();
      expect(NodeFS.existsSync(identityFile)).toBe(false);
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  });

  it("retains a newly created VM's identity when readiness fails and retries the same VM", async () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-tenki-"));
    const identityFile = NodePath.join(root, "identity.json");
    const { session } = mockSession("CREATING");
    sdk.create.mockClear().mockResolvedValue(session);
    sdk.get.mockClear().mockResolvedValue(session);
    session.waitReady.mockRejectedValueOnce(new Error("readiness unavailable"));
    const pool = new BotWorkspacePool();
    const create = () =>
      createRemoteBotWorkspace({
        sandbox: "tenki",
        threadId: "thread",
        workspaceId: "bot",
        identityFile,
        environment: { TENKI_API_KEY: "key" },
      });
    try {
      await expect(pool.acquire("tenki", create)).rejects.toThrow("readiness unavailable");
      expect(JSON.parse(NodeFS.readFileSync(identityFile, "utf8"))).toEqual({
        provider: "tenki",
        providerId: "tenki-session",
      });
      expect(session.close).not.toHaveBeenCalled();
      session.state = "RUNNING";
      const lease = await pool.acquire("tenki", create);
      expect(sdk.create).toHaveBeenCalledTimes(1);
      expect(sdk.get).toHaveBeenCalledExactlyOnceWith("tenki-session");
      await lease.release({ destroy: true });
      expect(session.close).toHaveBeenCalledOnce();
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed for a missing saved VM and requires credentials", async () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-tenki-"));
    const identityFile = NodePath.join(root, "identity.json");
    const input = {
      sandbox: "tenki" as const,
      threadId: "thread",
      workspaceId: "bot",
      identityFile,
    };
    try {
      await expect(createRemoteBotWorkspace(input)).rejects.toThrow("TENKI_API_KEY");
      NodeFS.writeFileSync(
        identityFile,
        JSON.stringify({ provider: "tenki", providerId: "missing" }),
      );
      sdk.create.mockClear();
      sdk.get.mockRejectedValueOnce(new Error("not found"));
      await expect(
        createRemoteBotWorkspace({ ...input, environment: { TENKI_API_KEY: "key" } }),
      ).rejects.toThrow("missing");
      expect(sdk.create).not.toHaveBeenCalled();
      expect(NodeFS.existsSync(identityFile)).toBe(true);
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  });

  it.each<SessionState>(["PAUSED", "USER_SHUTDOWN", "PAUSING", "RESUMING", "RUNNING"])(
    "waits for readiness when waking %s",
    async (state) => {
      const { adapter, session } = mockSession(state);
      await adapter.wake();
      expect(session.refresh).toHaveBeenCalledOnce();
      if (state === "RUNNING") {
        expect(session.waitReady).toHaveBeenCalledOnce();
        expect(session.resume).not.toHaveBeenCalled();
      } else {
        expect(session.waitResumed).toHaveBeenCalledOnce();
        expect(session.resume).toHaveBeenCalledTimes(state === "RESUMING" ? 0 : 1);
      }
      if (state === "PAUSING") expect(session.waitPaused).toHaveBeenCalledOnce();
    },
  );

  it("waits for the pause snapshot and propagates lifecycle failures", async () => {
    const { adapter, session } = mockSession();
    await adapter.sleep();
    expect(session.pause).toHaveBeenCalledOnce();
    expect(session.waitPaused).toHaveBeenCalledOnce();
    expect(await adapter.inspect()).toBe("sleeping");
    session.waitResumed.mockRejectedValueOnce(new Error("resume failed"));
    await expect(adapter.wake()).rejects.toThrow("resume failed");
    session.waitPaused.mockRejectedValueOnce(new Error("snapshot failed"));
    await expect(adapter.sleep()).rejects.toThrow("snapshot failed");
  });

  it("preserves argv, command options, output and nonzero exit codes", async () => {
    const { adapter, session } = mockSession();
    expect(
      await adapter.run("printf", ["hello world", "$(false)"], {
        cwd: "/home/tenki",
        env: { TEST: "value" },
        timeout: 1200,
      }),
    ).toEqual({ stdout: "hello 世界", stderr: "command failed", exitCode: 7 });
    expect(session.exec).toHaveBeenCalledWith(["printf", "hello world", "$(false)"], {
      cwd: "/home/tenki",
      env: { TEST: "value" },
      timeoutMs: 1200,
    });
  });

  it("does not publish unauthenticated browser control through a public preview", async () => {
    const { adapter, session } = mockSession();
    await expect(adapter.browserEndpoint(9223)).rejects.toThrow("authenticated endpoint");
    expect(session.exposePort).not.toHaveBeenCalled();
  });

  it.each<[SessionState, string]>([
    ["RUNNING", "running"],
    ["CREATING", "sleeping"],
    ["PAUSED", "sleeping"],
    ["USER_SHUTDOWN", "sleeping"],
    ["PAUSING", "sleeping"],
    ["RESUMING", "sleeping"],
    ["TERMINATED", "missing"],
    ["TERMINATING", "missing"],
    ["UNSPECIFIED", "missing"],
  ])("maps %s to %s", (state, expected) => {
    expect(tenkiWorkspaceState(state)).toBe(expected);
  });
});
