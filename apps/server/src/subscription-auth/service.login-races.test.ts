import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import type { SubscriptionCredentialStore } from "./credentialStore.ts";
import { codexDeviceFetch } from "./testUtils/codexDeviceFetch.ts";
import { makeTestSubscriptionAuthService } from "./testUtils/subscriptionAuthService.ts";

const directories: string[] = [];

afterEach(() => {
  vi.unstubAllGlobals();

  for (const directory of directories.splice(0))
    NodeFS.rmSync(directory, { recursive: true, force: true });
});

describe("OAuth completion ownership", () => {
  for (const cancelDuringWrite of [false, true]) {
    it(`retains exchanged credentials after a write failure unless cancelled (${cancelDuringWrite})`, async () => {
      const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-oauth-retry-"));
      directories.push(directory);
      const authPath = NodePath.join(directory, "subscription-auth.json");

      const service = await makeTestSubscriptionAuthService(authPath, {
        checkHealthOnConnect: false,
      });

      const other = await makeTestSubscriptionAuthService(authPath, {
        checkHealthOnConnect: false,
      });

      const request = codexDeviceFetch();
      vi.stubGlobal("fetch", request);
      const login = await service.startLogin("openai-codex");
      const store: SubscriptionCredentialStore = service["store"];
      const originalUpdate = store.update;

      const updateSpy = vi.spyOn(store, "update").mockImplementationOnce((update) =>
        originalUpdate((data) => {
          update(data);

          const pending: unknown[][] = JSON.parse(
            NodeFS.readFileSync(`${authPath}.pending`, "utf8"),
          );

          expect(pending.some(([id]) => id === login.loginId)).toBe(false);

          if (cancelDuringWrite) other.cancelLogin(login.loginId);
          throw new Error("disk write failed");
        }),
      );

      try {
        await expect(service.pollLogin(login.loginId)).rejects.toThrow("disk write failed");
        const retry = await service.pollLogin(login.loginId);
        expect(retry.status).toBe(cancelDuringWrite ? "failed" : "connected");
        expect(service.isConnected("openai-codex")).toBe(!cancelDuringWrite);
        expect(
          request.mock.calls.filter(([input]) =>
            String(input instanceof Request ? input.url : input).includes("/oauth/token"),
          ),
        ).toHaveLength(1);
      } finally {
        updateSpy.mockRestore();
      }
    });
  }

  for (const provider of ["openai-codex"] as const) {
    for (const cancellation of ["cancel", "logout"] as const) {
      it(`${provider} does not undo ${cancellation} while its credential update waits`, async () => {
        const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-oauth-race-"));
        directories.push(directory);
        const authPath = NodePath.join(directory, "subscription-auth.json");

        const service = await makeTestSubscriptionAuthService(authPath, {
          checkHealthOnConnect: false,
        });

        const other = await makeTestSubscriptionAuthService(authPath, {
          checkHealthOnConnect: false,
        });

        vi.stubGlobal("fetch", codexDeviceFetch());
        const login = await service.startLogin(provider);
        const store: SubscriptionCredentialStore = service["store"];
        const originalUpdate = store.update;
        let releaseUpdate = () => {};

        const held = new Promise<void>((resolve) => {
          releaseUpdate = resolve;
        });

        let reachedUpdate = () => {};

        const reached = new Promise<void>((resolve) => {
          reachedUpdate = resolve;
        });

        const updateSpy = vi.spyOn(store, "update").mockImplementationOnce((update) => {
          reachedUpdate();

          return Effect.promise(() => held).pipe(Effect.andThen(originalUpdate(update)));
        });

        try {
          const completing = service.pollLogin(login.loginId);

          await Promise.race([
            reached,
            completing.then(() => {
              throw new Error("Completion did not reach the credential update.");
            }),
          ]);

          if (cancellation === "logout") await other.logout(provider);
          else other.cancelLogin(login.loginId);
          releaseUpdate();
          expect(await completing).toEqual({
            status: "failed",
            error: "Login cancelled. Start again.",
          });
          expect(service.isConnected(provider)).toBe(false);
        } finally {
          releaseUpdate();
          updateSpy.mockRestore();
        }
      });
    }
  }
});
