import * as NodeFS from "node:fs";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createRemoteBotWorkspace } from "./botWorkspace.ts";
import { partialSdkFixture } from "./test-support/partialSdkFixture.ts";
import { identityFile, removeIdentityFiles, saved } from "./test-support/sandboxSdk.ts";
import { workspaceIO } from "./test-support/workspaceIO.ts";

afterEach(() => {
  removeIdentityFiles();
  vi.restoreAllMocks();
});

/** A Railway VM whose guest commands succeed or fail, and whose deletion can be made to fail. */
function railwayVm(id: string, commandsSucceed: boolean) {
  const destroy = vi.fn(async () => undefined);

  const vm = partialSdkFixture<import("railway").Sandbox>({
    id,
    status: "RUNNING",
    createdAt: "2026-10-31T00:00:00.000Z",
    destroy,
  });

  // `exec` and `files.read` are overloaded, which the typed fixture cannot express.
  Object.assign(vm, {
    exec: vi.fn(async () => ({
      exitCode: commandsSucceed ? 0 : 1,
      timedOut: false,
      stdout: "",
      stderr: "",
    })),
    files: {
      read: vi.fn(async (path: string) => {
        throw Object.assign(new Error(`${path} missing`), { name: "SandboxFileNotFoundError" });
      }),
    },
  });

  return { vm, destroy };
}

const input = (file: string) => ({
  io: workspaceIO,
  threadId: "thread-railway",
  sandbox: "railway" as const,
  workspaceId: "akeru-railway",
  identityFile: file,
  environment: { RAILWAY_API_TOKEN: "token", RAILWAY_ENVIRONMENT_ID: "environment" },
});

describe("a Railway create that fails inside the provider", () => {
  it("keeps the VM's ID when setup and the SDK's own cleanup both fail, then deletes it first", async () => {
    const { Sandbox } = await import("railway");
    const broken = railwayVm("railway-broken", false);
    const healthy = railwayVm("railway-healthy", true);

    broken.destroy.mockRejectedValueOnce(
      Object.assign(new Error("Railway is down"), { status: 503 }),
    );

    const create = vi
      .spyOn(Sandbox, "create")
      .mockResolvedValueOnce(broken.vm)
      .mockResolvedValueOnce(healthy.vm);

    vi.spyOn(Sandbox, "connect").mockImplementation(async (id) =>
      id === "railway-healthy" ? healthy.vm : broken.vm,
    );

    const file = identityFile();

    // Sandbox SDK allocates the VM, fails to initialize it, fails to delete it, and rejects.
    await expect(createRemoteBotWorkspace(input(file))).rejects.toThrow();
    expect(broken.destroy).toHaveBeenCalledOnce();
    expect(saved(file)).toEqual({
      provider: "railway",
      providerId: "railway-broken",
      workdir: "/workspace",
      cleanup: true,
    });

    // The next session deletes the leftover VM before creating a replacement.
    const workspace = await createRemoteBotWorkspace(input(file));
    expect(broken.destroy).toHaveBeenCalledTimes(2);
    expect(create).toHaveBeenCalledTimes(2);
    expect(workspace.providerId).toBe("railway-healthy");
    expect(saved(file)).toEqual({
      provider: "railway",
      providerId: "railway-healthy",
      workdir: "/workspace",
    });
  });

  it("keeps the leftover ID and creates nothing while its deletion keeps failing", async () => {
    const { Sandbox } = await import("railway");
    const broken = railwayVm("railway-broken", false);

    broken.destroy.mockRejectedValue(Object.assign(new Error("Railway is down"), { status: 503 }));
    const create = vi.spyOn(Sandbox, "create").mockResolvedValue(broken.vm);
    vi.spyOn(Sandbox, "connect").mockResolvedValue(broken.vm);

    const file = identityFile();

    await expect(createRemoteBotWorkspace(input(file))).rejects.toThrow();
    await expect(createRemoteBotWorkspace(input(file))).rejects.toThrow(
      "Could not delete railway sandbox 'railway-broken' left by a failed setup",
    );
    expect(create).toHaveBeenCalledOnce();
    expect(saved(file)).toMatchObject({ providerId: "railway-broken", cleanup: true });
    expect(NodeFS.existsSync(file)).toBe(true);
  });
});
