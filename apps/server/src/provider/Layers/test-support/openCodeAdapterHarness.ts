import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import { openCodeClientFixture } from "./partialFixtures.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { OpenCodeSettings, ThreadId } from "@akeru/contracts";
import { ServerConfig } from "../../../config.ts";
import { ServerSettingsService } from "../../../serverSettings.ts";
import { ProviderSessionDirectory } from "../../Services/ProviderSessionDirectory.ts";
import type { OpenCodeAdapterShape } from "../../Services/OpenCodeAdapter.ts";
import {
  OpenCodeRuntime,
  OpenCodeRuntimeError,
  type OpenCodeRuntimeShape,
} from "../../opencodeRuntime.ts";
// oxlint-disable-next-line anti-slop-effect/no-service-constructor-imports -- Test composition root builds the configured OpenCodeAdapter double or Layer for isolated provider tests.
import { makeOpenCodeAdapter } from "../OpenCodeAdapter.ts";

export class OpenCodeAdapter extends Context.Service<OpenCodeAdapter, OpenCodeAdapterShape>()(
  "akeru-bot/provider/Layers/test-support/openCodeAdapterHarness/OpenCodeAdapter",
) {}

export const asThreadId = (value: string): ThreadId => ThreadId.make(value);

export class OpenCodePermissionReplyTimeoutError extends Data.TaggedError(
  "OpenCodePermissionReplyTimeoutError",
)<{ readonly message: string }> {}

export type MessageEntry = {
  info: {
    id: string;
    role: "user" | "assistant";
  };
  parts: Array<unknown>;
};

export const providerSessionDirectoryTestLayer = Layer.succeed(ProviderSessionDirectory, {
  upsert: () => Effect.void,
  getProvider: () =>
    Effect.die(new Error("ProviderSessionDirectory.getProvider is not used in test")),
  getBinding: () => Effect.succeed(Option.none()),
  listThreadIds: () => Effect.succeed([]),
  listBindings: () => Effect.succeed([]),
});

export const openCodeAdapterTestSettings = Schema.decodeSync(OpenCodeSettings)({
  binaryPath: "fake-opencode",
  serverUrl: "http://127.0.0.1:9999",
  serverPassword: "secret-password",
});

export const advanceTestClock = (ms: number) =>
  TestClock.adjust(`${ms} millis`).pipe(Effect.andThen(Effect.yieldNow));

export function makeOpenCodeAdapterHarness() {
  const runtimeMock = {
    state: {
      startCalls: [] as string[],
      sessionCreateUrls: [] as string[],
      sessionCreateInputs: [] as Array<Parameters<OpencodeClient["session"]["create"]>[0]>,
      authHeaders: [] as Array<string | null>,
      abortCalls: [] as string[],
      abortImplementation: null as ((sessionID: string) => Promise<void>) | null,
      closeCalls: [] as string[],
      revertCalls: [] as Array<{ sessionID: string; messageID?: string }>,
      revertMessageID: undefined as string | undefined,
      promptCalls: [] as Array<unknown>,
      promptAsyncError: null as Error | null,
      closeError: null as Error | null,
      messages: [] as MessageEntry[],
      subscribedEvents: [] as unknown[],
      sessionGetIds: [] as string[],
      sessionGetHold: null as ((sessionID: string) => Promise<void>) | null,
      missingSessionIds: new Set<string>(),
      transientErrorSessionIds: new Set<string>(),
      sessionDirectoryById: new Map<string, string>(),
      sessionParentById: new Map<string, string>(),
      sessionChildrenById: new Map<string, Array<{ id: string }>>(),
      sessionChildrenCalls: [] as string[],
      sessionUpdateCalls: [] as Array<{ sessionID: string; permission: unknown }>,
      forkCalls: [] as Array<{ sessionID: string; directory?: string }>,
      mcpAddCalls: [] as Array<{ name: string; config: unknown }>,
      permissionReplyCalls: [] as Array<{ requestID: string; reply: string }>,
      permissionReplyError: null as Error | null,
      questionReplyCalls: [] as string[],
      questionReplyError: null as
        | Error
        | {
            readonly status?: number;
            readonly _tag?: string;
            readonly requestID?: string;
            readonly message?: string;
            readonly body?: { readonly _tag: string };
          }
        | null,
      permissionReplyImplementation: null as
        | ((requestID: string, reply: string, signal?: AbortSignal) => Promise<void>)
        | null,
    },
    reset() {
      this.state.startCalls.length = 0;
      this.state.sessionCreateUrls.length = 0;
      this.state.sessionCreateInputs.length = 0;
      this.state.authHeaders.length = 0;
      this.state.abortCalls.length = 0;
      this.state.abortImplementation = null;
      this.state.closeCalls.length = 0;
      this.state.revertCalls.length = 0;
      this.state.revertMessageID = undefined;
      this.state.promptCalls.length = 0;
      this.state.promptAsyncError = null;
      this.state.closeError = null;
      this.state.messages = [];
      this.state.subscribedEvents = [];
      this.state.sessionGetIds.length = 0;
      this.state.sessionGetHold = null;
      this.state.missingSessionIds.clear();
      this.state.transientErrorSessionIds.clear();
      this.state.sessionDirectoryById.clear();
      this.state.sessionParentById.clear();
      this.state.sessionChildrenById.clear();
      this.state.sessionChildrenCalls.length = 0;
      this.state.sessionUpdateCalls.length = 0;
      this.state.forkCalls.length = 0;
      this.state.mcpAddCalls.length = 0;
      this.state.permissionReplyCalls.length = 0;
      this.state.permissionReplyError = null;
      this.state.questionReplyCalls.length = 0;
      this.state.questionReplyError = null;
      this.state.permissionReplyImplementation = null;
    },
  };

  const OpenCodeRuntimeTestDouble: OpenCodeRuntimeShape = {
    startOpenCodeServerProcess: ({ binaryPath }) =>
      Effect.gen(function* () {
        runtimeMock.state.startCalls.push(binaryPath);
        const url = "http://127.0.0.1:4301";
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            runtimeMock.state.closeCalls.push(url);

            if (runtimeMock.state.closeError) {
              throw runtimeMock.state.closeError;
            }
          }),
        );

        return {
          url,
          exitCode: Effect.never,
        };
      }),
    connectToOpenCodeServer: ({ serverUrl }) =>
      Effect.gen(function* () {
        const url = serverUrl ?? "http://127.0.0.1:4301";
        // Always register a finalizer so the closeCalls/closeError probes fire;
        // production attaches none for external servers.
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            runtimeMock.state.closeCalls.push(url);

            if (runtimeMock.state.closeError) {
              throw runtimeMock.state.closeError;
            }
          }),
        );

        return {
          url,
          exitCode: null,
          external: Boolean(serverUrl),
        };
      }),
    runOpenCodeCommand: () => Effect.succeed({ stdout: "", stderr: "", code: 0 }),
    createOpenCodeSdkClient: ({ baseUrl, serverPassword }) =>
      openCodeClientFixture({
        session: {
          create: async (input) => {
            runtimeMock.state.sessionCreateUrls.push(baseUrl);
            runtimeMock.state.sessionCreateInputs.push(input);
            runtimeMock.state.authHeaders.push(
              serverPassword ? `Basic ${btoa(`opencode:${serverPassword}`)}` : null,
            );

            return { data: { id: `${baseUrl}/session` } };
          },
          get: async ({ sessionID }: { sessionID: string }) => {
            runtimeMock.state.sessionGetIds.push(sessionID);
            await runtimeMock.state.sessionGetHold?.(sessionID);

            // The real client is `throwOnError: true`: non-2xx rejects rather
            // than resolving, so missing → 404 throw, transient → 500 throw.
            if (runtimeMock.state.transientErrorSessionIds.has(sessionID)) {
              throw new Error("opencode server error", { cause: { status: 500 } });
            }

            if (runtimeMock.state.missingSessionIds.has(sessionID)) {
              throw new Error(`Session not found: ${sessionID}`, {
                cause: { status: 404, body: { name: "NotFoundError" } },
              });
            }

            const directory = runtimeMock.state.sessionDirectoryById.get(sessionID);
            const parentID = runtimeMock.state.sessionParentById.get(sessionID);

            return {
              data: {
                id: sessionID,
                ...(runtimeMock.state.revertMessageID
                  ? { revert: { messageID: runtimeMock.state.revertMessageID } }
                  : {}),
                ...(directory ? { directory } : {}),
                ...(parentID ? { parentID } : {}),
              },
            };
          },
          update: async ({ sessionID, permission }) => {
            runtimeMock.state.sessionUpdateCalls.push({ sessionID, permission });

            return { data: { id: sessionID } };
          },
          fork: async ({ sessionID, directory }: { sessionID: string; directory?: string }) => {
            // Fork clones history into a new session bound to the directory.
            const forkedId = `${sessionID}_fork`;
            runtimeMock.state.forkCalls.push({ sessionID, ...(directory ? { directory } : {}) });

            if (directory) {
              runtimeMock.state.sessionDirectoryById.set(forkedId, directory);
            }

            return { data: { id: forkedId, ...(directory ? { directory } : {}) } };
          },
          abort: async ({ sessionID }: { sessionID: string }) => {
            runtimeMock.state.abortCalls.push(sessionID);
            await runtimeMock.state.abortImplementation?.(sessionID);
          },
          children: async ({ sessionID }: { sessionID: string }) => {
            runtimeMock.state.sessionChildrenCalls.push(sessionID);

            return { data: runtimeMock.state.sessionChildrenById.get(sessionID) ?? [] };
          },
          promptAsync: async <Input>(input: Input) => {
            runtimeMock.state.promptCalls.push(input);

            if (runtimeMock.state.promptAsyncError) {
              throw runtimeMock.state.promptAsyncError;
            }
          },
          messages: async () => ({ data: runtimeMock.state.messages }),
          revert: async ({ sessionID, messageID }: { sessionID: string; messageID?: string }) => {
            runtimeMock.state.revertCalls.push({
              sessionID,
              ...(messageID ? { messageID } : {}),
            });

            if (!messageID) {
              throw new Error("Expected messageID");
            }

            let lastUserID: string | undefined;

            for (const entry of runtimeMock.state.messages) {
              if (entry.info.role === "user") lastUserID = entry.info.id;

              if (entry.info.id === messageID && entry.parts.length > 0) {
                runtimeMock.state.revertMessageID = lastUserID ?? messageID;
                break;
              }
            }
          },
        },
        event: {
          subscribe: async () => ({
            stream: (async function* () {
              for (const event of runtimeMock.state.subscribedEvents) {
                yield event;
              }
            })(),
          }),
        },
        permission: {
          reply: async ({ requestID, reply = "once" }, options) => {
            runtimeMock.state.permissionReplyCalls.push({ requestID, reply });

            if (runtimeMock.state.permissionReplyError) {
              throw runtimeMock.state.permissionReplyError;
            }

            await runtimeMock.state.permissionReplyImplementation?.(
              requestID,
              reply,
              options?.signal ?? undefined,
            );
          },
        },
        question: {
          reply: async ({ requestID }: { requestID: string }) => {
            runtimeMock.state.questionReplyCalls.push(requestID);

            if (runtimeMock.state.questionReplyError) {
              throw runtimeMock.state.questionReplyError;
            }
          },
        },
        mcp: {
          add: async (input) => {
            if (!input?.name || !input.config) throw new Error("Expected MCP name and config");
            runtimeMock.state.mcpAddCalls.push({ name: input.name, config: input.config });

            return { data: true };
          },
        },
      }),
    loadOpenCodeInventory: () =>
      Effect.fail(
        new OpenCodeRuntimeError({
          operation: "loadOpenCodeInventory",
          detail: "OpenCodeRuntimeTestDouble.loadOpenCodeInventory not used in this test",
          cause: null,
        }),
      ),
    loadInventoryFromCli: () =>
      Effect.fail(
        new OpenCodeRuntimeError({
          operation: "loadInventoryFromCli",
          detail: "OpenCodeRuntimeTestDouble.loadInventoryFromCli not used in this test",
          cause: null,
        }),
      ),
  };

  const OpenCodeAdapterTestLayer = Layer.effect(
    OpenCodeAdapter,
    makeOpenCodeAdapter(openCodeAdapterTestSettings),
  ).pipe(
    Layer.provideMerge(Layer.succeed(OpenCodeRuntime, OpenCodeRuntimeTestDouble)),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(
      ServerSettingsService.layerTest({
        providers: {
          opencode: {
            binaryPath: "fake-opencode",
            serverUrl: "http://127.0.0.1:9999",
            serverPassword: "secret-password",
          },
        },
      }),
    ),
    Layer.provideMerge(providerSessionDirectoryTestLayer),
    Layer.provideMerge(NodeServices.layer),
  );

  return { runtimeMock, OpenCodeRuntimeTestDouble, OpenCodeAdapterTestLayer };
}
