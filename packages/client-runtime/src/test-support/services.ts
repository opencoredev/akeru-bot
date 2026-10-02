import * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import {
  EnvironmentId,
  DEFAULT_SERVER_SETTINGS,
  type ServerConfig,
  WsRpcGroup,
} from "@akeru/contracts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import type { RpcSession } from "../rpc/session.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";

function unexpectedCall(): never {
  throw new Error("The test did not configure this service operation.");
}

type TestRpcResult<R> =
  R extends Effect.Effect<infer A, infer E>
    ? Effect.Effect<A, E | Error>
    : R extends Stream.Stream<infer A, infer E>
      ? Stream.Stream<A, E | Error>
      : never;

type TestRpcMethods = {
  [K in keyof WsRpcProtocolClient]?: (
    input: Parameters<WsRpcProtocolClient[K]>[0],
  ) => TestRpcResult<ReturnType<WsRpcProtocolClient[K]>>;
};

export function testRpcClient(overrides: TestRpcMethods): WsRpcProtocolClient {
  const methods: Partial<WsRpcProtocolClient> = Object.fromEntries(
    Array.from(WsRpcGroup.requests.keys(), (method) => [method, unexpectedCall]),
  );

  // SAFETY: All RPC keys are filled from WsRpcGroup. Tests use default RPC options and can inject malformed peer failures. Every omitted method fails immediately.
  const client = methods as WsRpcProtocolClient;

  return Object.assign(client, overrides);
}

export function testEnvironmentRegistry(
  overrides: Partial<EnvironmentRegistry.EnvironmentRegistry["Service"]>,
) {
  return EnvironmentRegistry.EnvironmentRegistry.of({
    get entries() {
      return unexpectedCall();
    },
    get networkStatus() {
      return unexpectedCall();
    },
    get start() {
      return unexpectedCall();
    },
    register: unexpectedCall,
    registerPlatform: unexpectedCall,
    reconcilePlatform: unexpectedCall,
    remove: unexpectedCall,
    retryNow: unexpectedCall,
    state: unexpectedCall,
    stateChanges: unexpectedCall,
    run: unexpectedCall,
    runStream: unexpectedCall,
    followStream: unexpectedCall,
    ...overrides,
  });
}

export function testRpcSession(overrides: Partial<RpcSession> = {}): RpcSession {
  return {
    client: testRpcClient({}),
    initialConfig: Effect.die("Initial config is not configured by this test."),
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
    ...overrides,
  };
}

export const TEST_SERVER_CONFIG: ServerConfig = {
  environment: {
    environmentId: EnvironmentId.make("environment-1"),
    label: "Test environment",
    platform: { os: "linux", arch: "x64" },
    serverVersion: "0.0.29",
    capabilities: { repositoryIdentity: false },
  },
  auth: {
    policy: "loopback-browser",
    bootstrapMethods: [],
    sessionMethods: [],
    sessionCookieName: "t3_session",
  },
  cwd: "/tmp/workspace",
  availableEditors: [],
  issues: [],
  keybindings: [],
  keybindingsConfigPath: "/tmp/keybindings.json",
  observability: {
    logsDirectoryPath: "/tmp/logs",
    localTracingEnabled: false,
    otlpTracesEnabled: false,
    otlpMetricsEnabled: false,
  },
  providers: [],
  settings: DEFAULT_SERVER_SETTINGS,
};
