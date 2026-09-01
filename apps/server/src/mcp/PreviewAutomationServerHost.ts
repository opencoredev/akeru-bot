import {
  PREVIEW_AUTOMATION_OPERATIONS,
  type PreviewAutomationOperation,
  type PreviewAutomationResponse,
  type PreviewAutomationStreamEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Data from "effect/Data";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerPreviewBrowser from "../preview/ServerPreviewBrowser.ts";
import * as PreviewAutomationBroker from "./PreviewAutomationBroker.ts";

const SERVER_OPERATIONS = PREVIEW_AUTOMATION_OPERATIONS.filter(
  (operation): operation is PreviewAutomationOperation =>
    operation !== "recordingStart" && operation !== "recordingStop",
);

const responseForFailure = (input: {
  readonly clientId: string;
  readonly connectionId: string;
  readonly requestId: string;
  readonly cause: unknown;
}): PreviewAutomationResponse => {
  const message = input.cause instanceof Error ? input.cause.message : "Browser operation failed.";
  return {
    clientId: input.clientId,
    connectionId: input.connectionId,
    requestId: input.requestId,
    ok: false,
    error: {
      _tag: message.startsWith("No active browser tab")
        ? "PreviewAutomationTabNotFoundError"
        : "PreviewAutomationExecutionError",
      message,
    },
  };
};

class ServerPreviewOperationError extends Data.TaggedError("ServerPreviewOperationError")<{
  readonly cause: unknown;
}> {}

export const hostLayer = Layer.effectDiscard(
  Effect.gen(function* PreviewAutomationServerHost() {
    const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
    const browser = yield* ServerPreviewBrowser.ServerPreviewBrowser;
    const environment = yield* ServerEnvironment.ServerEnvironment;
    const environmentId = yield* environment.getEnvironmentId;
    const clientId = `server-preview-${environmentId}`;
    const events = yield* broker.connect({
      clientId,
      environmentId,
      supportedOperations: SERVER_OPERATIONS,
    });

    const handleEvent = (event: PreviewAutomationStreamEvent) => {
      if (event.type === "connected") return Effect.void;
      return Effect.tryPromise({
        try: () => browser.handle(event.request),
        catch: (cause) => new ServerPreviewOperationError({ cause }),
      }).pipe(
        Effect.matchEffect({
          onFailure: (error) =>
            broker.respond(
              responseForFailure({
                clientId,
                connectionId: event.connectionId,
                requestId: event.request.requestId,
                cause: error.cause,
              }),
            ),
          onSuccess: (result) =>
            broker.respond({
              clientId,
              connectionId: event.connectionId,
              requestId: event.request.requestId,
              ok: true,
              ...(result === undefined ? {} : { result }),
            }),
        }),
        Effect.catchCause((cause) =>
          Effect.logWarning("Server preview host response failed", {
            cause,
            operation: event.request.operation,
            requestId: event.request.requestId,
          }),
        ),
      );
    };

    yield* Effect.forkScoped(Stream.runForEach(events, handleEvent));
  }),
);

export const layer = hostLayer.pipe(Layer.provide(ServerPreviewBrowser.layer));
