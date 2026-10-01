// @effect-diagnostics nodeBuiltinImport:off globalDate:off preferSchemaOverJson:off

import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import type { SubscriptionCredentialStore } from "./credentialStore.ts";
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

      const request = vi.fn(async () =>
        Response.json({ access_token: "access", refresh_token: "refresh", expires_in: 3600 }),
      );

      vi.stubGlobal("fetch", request);
      const login = await service.startLogin("anthropic");
      const state = new URL(login.url!).searchParams.get("state");
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
        expect((await service.completeLogin(login.loginId, `code#${state}`)).status).toBe("failed");
        const retry = await service.completeLogin(login.loginId, `code#${state}`);
        expect(retry.status).toBe(cancelDuringWrite ? "failed" : "connected");
        expect(service.isConnected("anthropic")).toBe(!cancelDuringWrite);
        expect(request).toHaveBeenCalledOnce();
      } finally {
        updateSpy.mockRestore();
      }
    });
  }

  for (const provider of ["anthropic", "openai-codex"] as const) {
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

        vi.stubGlobal(
          "fetch",
          vi.fn(async (input) => {
            const url = String(input instanceof Request ? input.url : input);

            const body = url.endsWith("/deviceauth/usercode")
              ? { device_auth_id: "device", user_code: "user", interval: 1 }
              : url.endsWith("/deviceauth/token")
                ? { authorization_code: "code", code_verifier: "verifier" }
                : {
                    access_token: "late-access",
                    refresh_token: "refresh",
                    expires_in: 3600,
                    id_token: `header.${Buffer.from(JSON.stringify({ chatgpt_account_id: "account" })).toString("base64url")}.signature`,
                  };

            return Response.json(body);
          }),
        );
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
          const state = new URL(login.url!).searchParams.get("state");

          const completing =
            provider === "anthropic"
              ? service.completeLogin(login.loginId, `code#${state}`)
              : service.pollLogin(login.loginId);

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
