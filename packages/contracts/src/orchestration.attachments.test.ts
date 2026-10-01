import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { isProviderSendTurnSupportedImageMimeType } from "./orchestration.ts";
import { decodeOrchestrationCommand } from "./orchestration.test-support.ts";

it.effect("project favicon overrides accept only supported image files", () =>
  Effect.gen(function* () {
    const valid = yield* decodeOrchestrationCommand({
      type: "project.meta.update",
      commandId: "cmd-project-favicon",
      projectId: "project-1",
      faviconPath: "brand/icon.svg",
    });
    assert.strictEqual(valid.type, "project.meta.update");

    const invalid = yield* Effect.exit(
      decodeOrchestrationCommand({
        type: "project.meta.update",
        commandId: "cmd-project-secret",
        projectId: "project-1",
        faviconPath: ".env",
      }),
    );
    assert.strictEqual(invalid._tag, "Failure");
  }),
);

it("isProviderSendTurnSupportedImageMimeType accepts raster formats and rejects svg", () => {
  assert.strictEqual(isProviderSendTurnSupportedImageMimeType("image/png"), true);
  assert.strictEqual(isProviderSendTurnSupportedImageMimeType("IMAGE/JPEG"), true);
  assert.strictEqual(isProviderSendTurnSupportedImageMimeType("image/svg+xml"), false);
});
