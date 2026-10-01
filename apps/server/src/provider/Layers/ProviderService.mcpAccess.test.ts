// @effect-diagnostics nodeBuiltinImport:off
import { ProviderDriverKind } from "@akeru/contracts";
import { it, assert, describe } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as ProviderService from "../Services/ProviderService.ts";
import { activateImageGenerationRuntime } from "../../image-generation/ImageGenerationRuntime.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  asThreadId,
  codexInstanceId,
  revokedThreads,
  startSessionWith,
  makeProviderServiceHarness,
} from "./test-support/providerServiceHarness.ts";

const { routing } = makeProviderServiceHarness();

routing.layer("ProviderServiceLive routing", (it) => {
  it.effect("cancels in-flight image requests when a session stops", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const threadId = asThreadId("thread-image-stop");
      const cancelled: string[] = [];
      yield* activateImageGenerationRuntime({
        generate: () => Effect.die("unused image generation"),
        cancelThread: (id) => Effect.sync(() => void cancelled.push(id)),
      });
      yield* provider.startSession(threadId, {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId,
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });
      yield* provider.stopSession({ threadId });
      assert.deepEqual(cancelled, [threadId]);
    }).pipe(Effect.scoped),
  );
});

describe("agent browser access", () => {
  it.effect("requests no MCP credential when agent browser access is off", () =>
    Effect.gen(function* () {
      const issued = yield* startSessionWith(false, asThreadId("thread-browser-off"));

      assert.deepEqual([...issued], []);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("agent browser access", () => {
  it.effect("revokes an already-issued credential when access is off", () =>
    Effect.gen(function* () {
      const threadId = asThreadId("thread-browser-revoke");
      revokedThreads.length = 0;

      yield* startSessionWith(false, threadId);

      // Clearing the in-memory map is not enough: a token issued before the
      // toggle flipped stays valid against `/mcp` for its whole liveness
      // window, and later turns refresh it.
      assert.deepEqual(revokedThreads, [threadId]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("agent browser access", () => {
  it.effect("requests an MCP credential when agent browser access is on", () =>
    Effect.gen(function* () {
      const threadId = asThreadId("thread-browser-on");

      const issued = yield* startSessionWith(true, threadId);

      assert.deepEqual(issued, [threadId]);
      assert.deepEqual(issued.capabilities, [["preview"]]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("agent browser access", () => {
  it.effect("grants only the image tool when image generation is on without browser access", () =>
    Effect.gen(function* () {
      const threadId = asThreadId("thread-image-only");

      const issued = yield* startSessionWith(false, threadId, { grokEnabled: true });

      assert.deepEqual(issued, [threadId]);
      assert.deepEqual(issued.capabilities, [["image"]]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("agent browser access", () => {
  it.effect("grants preview and image together when both are on", () =>
    Effect.gen(function* () {
      const issued = yield* startSessionWith(true, asThreadId("thread-image-and-preview"), {
        chatgptEnabled: true,
      });

      assert.deepEqual(issued.capabilities, [["image", "preview"]]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
