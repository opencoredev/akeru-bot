import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as NodeFS from "node:fs";
import { expect, it, vi } from "vite-plus/test";

import { SubscriptionAccountState } from "./accountState.ts";
import { subscriptionCredentialStore } from "./credentialStore.ts";
import { SubscriptionHealthService } from "./healthService.ts";
import { fixture } from "./testUtils/subscriptionAuthStorage.ts";
import { runWithNodeServices } from "./testUtils/subscriptionAuthService.ts";

it.each(["reorder", "remember"] as const)(
  "merges a concurrent provider order during %s",
  async (operation) => {
    const { authPath, directory } = fixture();
    NodeFS.writeFileSync(
      authPath,
      JSON.stringify({
        "openai-codex": { type: "api-key", access: "codex-key" },
        "account:openai-codex:backup": { type: "api-key", access: "codex-backup" },
        xai: { type: "api-key", access: "grok-key" },
        "account:xai:backup": { type: "api-key", access: "grok-backup" },
      }),
    );
    NodeFS.writeFileSync(
      `${authPath}.accounts`,
      JSON.stringify({ "openai-codex": ["default", "backup"], xai: ["default", "backup"] }),
    );

    const accounts = await runWithNodeServices(
      Effect.gen(function* () {
        const store = yield* subscriptionCredentialStore(authPath);
        yield* store.reload;
        const clock = yield* Clock.Clock;
        const path = yield* Path.Path;
        const reload = () => store.reload;

        return new SubscriptionAccountState(
          store,
          new SubscriptionHealthService(store, clock, path, false, reload),
          clock,
          reload,
        );
      }),
    );

    const linkedAccountIds = accounts.linkedAccountIds.bind(accounts);

    const lookup = vi.spyOn(accounts, "linkedAccountIds").mockImplementationOnce((provider) => {
      const ids = linkedAccountIds(provider);
      // Another process writes after this operation has read its linked accounts.
      NodeFS.writeFileSync(
        `${authPath}.accounts`,
        JSON.stringify({ "openai-codex": ["default", "backup"], xai: ["backup", "default"] }),
      );

      return ids;
    });

    try {
      if (operation === "reorder")
        await accounts.setAccountOrder("openai-codex", ["backup", "default"]);
      else accounts.rememberAccountOrder("openai-codex");
      expect(JSON.parse(NodeFS.readFileSync(`${authPath}.accounts`, "utf-8"))).toEqual({
        "openai-codex": operation === "reorder" ? ["backup", "default"] : ["default", "backup"],
        xai: ["backup", "default"],
      });
      expect(NodeFS.statSync(`${authPath}.accounts`).mode & 0o777).toBe(0o600);
    } finally {
      lookup.mockRestore();
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  },
);
