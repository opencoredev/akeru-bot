import { DateTime } from "effect";
import { vi } from "vite-plus/test";
import { ascii, type AkeruRemoteSession } from "../botWorkspace.ts";

export function makebotWorkspaceTestSupport() {
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

  return { remoteSession, deleted, setup };
}
