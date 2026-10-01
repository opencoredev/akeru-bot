import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId, PreviewTabId, ProviderInstanceId, ThreadId } from "@akeru/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/unstable/ai";
import { PNG } from "pngjs";
import * as McpHttpServer from "../McpHttpServer.ts";
import * as PreviewAutomationBroker from "../PreviewAutomationBroker.ts";

const environmentId = EnvironmentId.make("environment-mcp-test");

const threadId = ThreadId.make("thread-mcp-test");

const tabId = PreviewTabId.make("tab-mcp-test");

const alternateTabId = PreviewTabId.make("tab-mcp-alternate");

const screenshot = (() => {
  const png = new PNG({ width: 10, height: 5 });
  png.data.fill(255);

  return PNG.sync.write(png).toString("base64");
})();

const invocation = {
  environmentId,
  threadId,
  providerSessionId: "provider-session-mcp-test",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(["preview"] as const),
  issuedAt: 1,
};

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mcp-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

const TestLayer = McpHttpServer.PreviewToolkitRegistrationLive.pipe(
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provideMerge(PreviewAutomationBroker.layer.pipe(Layer.provide(NodeServices.layer))),
);

export {
  environmentId,
  threadId,
  tabId,
  alternateTabId,
  screenshot,
  invocation,
  client,
  TestLayer,
};
