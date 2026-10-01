import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as ServerSettingsModule from "./serverSettings.ts";

import { makeServerSettingsLayer } from "./serverSettingsTestSupport.ts";

it.layer(NodeServices.layer)("server settings", (it) => {
  it.effect("preserves both image providers when clients enable them concurrently", () =>
    Effect.gen(function* () {
      const settings = yield* ServerSettingsModule.ServerSettingsService;
      yield* Effect.all(
        [
          settings.updateSettings({ imageGeneration: { chatgptEnabled: true } }),
          settings.updateSettings({ imageGeneration: { grokEnabled: true } }),
        ],
        { concurrency: "unbounded" },
      );

      const image = (yield* settings.getSettings).imageGeneration;
      assert.isTrue(image.chatgptEnabled);
      assert.isTrue(image.grokEnabled);
      assert.sameMembers([...image.fallbackOrder], ["chatgpt", "grok"]);
      assert.include(["chatgpt", "grok"], image.defaultProvider);
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );
});
