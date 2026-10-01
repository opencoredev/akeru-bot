import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  PreviewTabId,
  ProviderInstanceId,
  ThreadId,
  type PreviewAutomationHost,
  type PreviewAutomationRequest,
  type PreviewAutomationStreamEvent,
} from "@akeru/contracts";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import { PNG } from "pngjs";
import * as PreviewAutomationBroker from "../PreviewAutomationBroker.ts";

const makeBroker = PreviewAutomationBroker.make.pipe(Effect.provide(NodeServices.layer));

const scope = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-1"),
  providerSessionId: "provider-session-1",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(["preview"] as const),
  issuedAt: 1,
};

const makeHost = (overrides: Partial<PreviewAutomationHost> = {}): PreviewAutomationHost => ({
  clientId: "client-1",
  environmentId: scope.environmentId,
  ...overrides,
});

const snapshotResult = (() => {
  const png = new PNG({ width: 1, height: 1 });
  png.data.fill(255);
  return {
    url: "http://localhost:3200",
    title: "Example",
    loading: false,
    visibleText: "Example",
    interactiveElements: [],
    accessibilityTree: {},
    consoleEntries: [],
    networkEntries: [],
    actionTimeline: [],
    screenshot: {
      mimeType: "image/png" as const,
      data: PNG.sync.write(png).toString("base64"),
      width: 1,
      height: 1,
    },
  };
})();

const recordingResult = (tabId: PreviewTabId) => ({
  id: "recording-1",
  tabId,
  path: "/Users/leo/.akeru/browser-artifacts/recording.webm",
  mimeType: "video/webm",
  sizeBytes: 123,
  createdAt: "2026-01-01T00:00:00Z",
});

type RoutedRequest = PreviewAutomationRequest & {
  readonly connectionId: PreviewAutomationStreamEvent["connectionId"];
};

const requestsFrom = (
  events: Stream.Stream<PreviewAutomationStreamEvent>,
  onConnected: (connectionId: PreviewAutomationStreamEvent["connectionId"]) => void = () => {},
): Stream.Stream<RoutedRequest> =>
  events.pipe(
    Stream.filterMap((event) => {
      if (event.type === "connected") {
        onConnected(event.connectionId);
        return Result.failVoid;
      }
      return Result.succeed({ ...event.request, connectionId: event.connectionId });
    }),
  );
export {
  makeBroker,
  scope,
  makeHost,
  snapshotResult,
  recordingResult,
  type RoutedRequest,
  requestsFrom,
};
