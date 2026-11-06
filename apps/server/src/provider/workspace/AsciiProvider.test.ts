import { connectSandbox, createSandbox, SandboxError } from "@opencoredev/sandbox-sdk";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { asciiProvider } from "./AsciiProvider.ts";

type BoxState = "ready" | "archiving" | "archived";

async function fixture(initial: BoxState = "ready") {
  const sdk = await import("@asciidev/box-sdk");
  let state: BoxState = initial;
  const box = { id: "ascii-id", name: "test", desktopAvailable: false, snapshotAvailable: true };

  vi.spyOn(sdk.BoxApi.prototype, "create").mockResolvedValue({
    ok: true,
    type: "box.created",
    status: "provisioning",
    ttlSeconds: null,
    box: { ...box, state: "ready" },
  });

  const get = vi
    .spyOn(sdk.BoxApi.prototype, "get")
    .mockImplementation(async () => ({ ok: true, type: "box.info", box: { ...box, state } }));

  const command = vi.spyOn(sdk.BoxApi.prototype, "command").mockResolvedValue({
    ok: true,
    type: "command.finished",
    success: false,
    exitCode: 7,
    stdout: "out",
    stderr: "err",
    timedOut: false,
  });

  const stop = vi.spyOn(sdk.BoxApi.prototype, "stop").mockImplementation(async () => {
    state = "archived";

    return { ok: true, type: "box.stopped", id: "ascii-id", status: "archived" };
  });

  const resume = vi.spyOn(sdk.BoxApi.prototype, "resume").mockImplementation(async () => {
    state = "ready";

    return { ok: true, type: "box.resumed", id: "ascii-id", status: "ready" };
  });

  return { sdk, get, command, stop, resume, provider: await asciiProvider("test-key") };
}

const deletion = (status: "pending" | "completed") => ({
  ok: true as const,
  type: "box.deleting" as const,
  operation: {
    id: "deletion",
    kind: "box" as const,
    targetId: "ascii-id",
    reason: "explicit" as const,
    status,
    attemptCount: 0,
    requestedAt: new Date(0),
    completedAt: null,
  },
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("Ascii Box sandbox-sdk shim", () => {
  it("runs quoted commands in one Ascii call and keeps nonzero exits", async () => {
    const { command, provider } = await fixture();
    const box = await createSandbox(provider);

    const result = await box.run('printf %s "a\'b"', {
      cwd: "/workspace/my files",
      env: { VALUE: "x; echo unsafe" },
      timeoutMs: 1501,
    });

    expect(result).toMatchObject({ exitCode: 7, stdout: "out", stderr: "err", ok: false });
    expect(command).toHaveBeenCalledOnce();
    const request = command.mock.calls[0]?.[0];
    expect(request?.boxId).toBe("ascii-id");
    expect(request?.commandRequest.timeoutSeconds).toBe(2);
    expect(request?.commandRequest.command).toContain("cd '/workspace/my files' && env ");
    expect(request?.commandRequest.command).toContain("'VALUE=x; echo unsafe'");
  });

  it("refuses command timeouts longer than ten minutes before running anything", async () => {
    const { command, provider } = await fixture();
    const box = await createSandbox(provider);

    await expect(box.run("sleep 1", { timeoutMs: 900_000 })).rejects.toThrow("at most 600000 ms");
    // Only the SDK's own run-marker cleanup reaches the box; the command itself never starts.
    expect(
      command.mock.calls.some(([request]) => request.commandRequest.command.includes("sleep 1")),
    ).toBe(false);
  });

  it("pauses with a native snapshot and resumes the same box", async () => {
    const { stop, resume, provider } = await fixture();
    const box = await createSandbox(provider);

    expect(box.capabilities.has("pause")).toBe(true);
    await box.pause?.();
    expect(stop).toHaveBeenCalledWith({ boxId: "ascii-id" });
    await expect(provider.connect("ascii-id")).resolves.toMatchObject({ state: "paused" });
    await box.resume?.();
    expect(resume).toHaveBeenCalledWith({ boxId: "ascii-id", resumeRequest: { ttlSeconds: null } });
    await expect(provider.connect("ascii-id")).resolves.toMatchObject({ state: "running" });
  });

  it("waits for pending deletion and confirms it by box ID", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "performance"] });
    const { sdk, provider } = await fixture();

    const remove = vi
      .spyOn(sdk.BoxApi.prototype, "deleteBox")
      .mockResolvedValue(deletion("pending"));

    const poll = vi
      .spyOn(sdk.BoxApi.prototype, "getDeletionOperation")
      .mockResolvedValue(deletion("completed"));

    const box = await createSandbox(provider);
    let complete = false;

    const destroy = box.destroy().then(() => {
      complete = true;
    });

    await vi.advanceTimersByTimeAsync(2_000);
    await destroy;
    expect(complete).toBe(true);
    expect(remove).toHaveBeenCalledWith({ boxId: "ascii-id", xAsciiConfirmDelete: "ascii-id" });
    expect(poll).toHaveBeenCalledWith({ operationId: "deletion" });
  });

  it("reports a deleted box as not_found and auth failures as auth", async () => {
    const { sdk, get, provider } = await fixture();

    const response = (status: number) =>
      new sdk.ResponseError(new Response(null, { status }), "failed");

    get.mockRejectedValueOnce(response(404));
    await expect(connectSandbox(provider, "ascii-id")).rejects.toMatchObject({ code: "not_found" });
    get.mockRejectedValueOnce(response(401));

    const failure = await provider.connect("ascii-id").catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(SandboxError);
    expect(failure).toMatchObject({ code: "auth" });
  });

  it("returns only protected preview URLs", async () => {
    const { sdk, provider } = await fixture();

    const hostPort = vi.spyOn(sdk.BoxApi.prototype, "hostPort").mockResolvedValue({
      ok: true,
      type: "host_port",
      url: "https://preview.example/?_token=browser-token",
      isProtected: true,
    });

    await expect(provider.previewUrl("ascii-id", 9223)).resolves.toEqual({
      url: "https://preview.example/?_token=browser-token",
    });
    expect(hostPort).toHaveBeenCalledWith({
      boxId: "ascii-id",
      hostPortRequest: { port: 9223, _public: false },
    });
    hostPort.mockResolvedValue({
      ok: true,
      type: "host_port",
      url: "https://preview.example",
      isProtected: false,
    });
    await expect(provider.previewUrl("ascii-id", 9223)).rejects.toThrow("protected preview URL");
  });
});
