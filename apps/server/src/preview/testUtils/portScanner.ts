import * as NodeNet from "node:net";
import { HostProcessPlatform } from "@akeru/shared/hostProcess";
import * as Net from "@akeru/shared/Net";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import { FetchHttpClient } from "effect/unstable/http";
import * as ProcessRunner from "../../processRunner.ts";
import * as PortScanner from "../PortScanner.ts";

const processProbeFailure: ProcessRunner.ProcessRunner["Service"]["run"] = (input) =>
  Effect.fail(
    new ProcessRunner.ProcessSpawnError({
      command: input.command,
      argumentCount: input.args.length,
      cwd: input.cwd,
      cause: PlatformError.systemError({
        _tag: "NotFound",
        module: "ChildProcess",
        method: "spawn",
        description: "PowerShell is not installed in the test environment",
      }),
    }),
  );

const TestProcessRunner = Layer.succeed(ProcessRunner.ProcessRunner, {
  run: processProbeFailure,
});

let integrationListeningPort: number | null = null;

const TestIntegrationNet = Layer.succeed(Net.NetService, {
  canListenOnHost: () => Effect.succeed(true),
  isPortAvailableOnLoopback: (port) => Effect.sync(() => port !== integrationListeningPort),
  hasListenerOnHost: (port) => Effect.sync(() => port === integrationListeningPort),
  reserveLoopbackPort: () => Effect.succeed(40_000),
  findAvailablePort: (preferred) => Effect.succeed(preferred),
});

const makeProbeFailureLayer = (
  run: ProcessRunner.ProcessRunner["Service"]["run"],
  fetch: typeof globalThis.fetch = globalThis.fetch,
) =>
  PortScanner.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(ProcessRunner.ProcessRunner, { run }),
        Layer.succeed(Net.NetService, {
          canListenOnHost: () => Effect.succeed(true),
          isPortAvailableOnLoopback: () => Effect.succeed(true),
          hasListenerOnHost: () => Effect.succeed(false),
          reserveLoopbackPort: () => Effect.succeed(40_000),
          findAvailablePort: (preferred) => Effect.succeed(preferred),
        }),
        Layer.succeed(HostProcessPlatform, "linux"),
        FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch))),
      ),
    ),
  );

const TestPortDiscoveryLive = PortScanner.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      TestProcessRunner,
      TestIntegrationNet,
      Layer.succeed(HostProcessPlatform, "win32"),
      FetchHttpClient.layer,
    ),
  ),
);

const LSOF_TEST_PORT = 43_123;

const makeLsofScannerLayer = (input: {
  readonly pid: () => number;
  readonly fetch: typeof globalThis.fetch;
}) =>
  PortScanner.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(ProcessRunner.ProcessRunner, {
          run: () =>
            Effect.succeed({
              stdout: `p${input.pid()}\ncnode\nn*:${LSOF_TEST_PORT}\n`,
              stderr: "",
              code: null,
              timedOut: false,
              stdoutTruncated: false,
              stderrTruncated: false,
              stdoutInvalidUtf8: false,
              stderrInvalidUtf8: false,
            }),
        }),
        Layer.succeed(Net.NetService, {
          canListenOnHost: () => Effect.succeed(true),
          isPortAvailableOnLoopback: () => Effect.succeed(true),
          hasListenerOnHost: () => Effect.succeed(false),
          reserveLoopbackPort: () => Effect.succeed(40_000),
          findAvailablePort: (preferred) => Effect.succeed(preferred),
        }),
        Layer.succeed(HostProcessPlatform, "linux"),
        FetchHttpClient.layer.pipe(
          Layer.provide(Layer.succeed(FetchHttpClient.Fetch, input.fetch)),
        ),
      ),
    ),
  );

const openServer = (
  port: number,
  onConnection: (socket: NodeNet.Socket) => void,
): Effect.Effect<NodeNet.Server | null> =>
  Effect.callback((resume) => {
    const server = NodeNet.createServer(onConnection);
    server.once("error", () => {
      resume(Effect.succeed(null));
    });
    server.listen(port, "127.0.0.1", () => {
      resume(Effect.succeed(server));
    });
    return Effect.sync(() => {
      server.close();
    });
  });

const closeServer = (server: NodeNet.Server): Effect.Effect<void> =>
  Effect.callback((resume) => {
    server.close(() => resume(Effect.void));
  });

const openCommonDevServer = Effect.fn("PortScannerTest.openCommonDevServer")(function* (
  ports: ReadonlyArray<number>,
  onConnection: (socket: NodeNet.Socket) => void,
) {
  for (const port of ports) {
    const server = yield* openServer(port, onConnection);
    if (server !== null) return { port, server };
  }
  return yield* Effect.die(
    new Error("No common development port was available for the preview scanner test"),
  );
});

const commonDevServer = Effect.acquireRelease(
  openCommonDevServer(PortScanner.COMMON_DEV_PORTS, (socket) => {
    socket.once("data", () => {
      socket.end("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: 5\r\n\r\nhello");
    });
  }).pipe(
    Effect.tap(({ port }) =>
      Effect.sync(() => {
        integrationListeningPort = port;
      }),
    ),
  ),
  ({ server }) =>
    closeServer(server).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          integrationListeningPort = null;
        }),
      ),
    ),
);

const commonNonHttpServer = Effect.acquireRelease(
  openCommonDevServer(PortScanner.COMMON_DEV_PORTS.toReversed(), (socket) => {
    socket.on("error", () => undefined);
    socket.once("data", () => socket.end("MYSQL\r\n\r\n"));
  }).pipe(
    Effect.tap(({ port }) =>
      Effect.sync(() => {
        integrationListeningPort = port;
      }),
    ),
  ),
  ({ server }) =>
    closeServer(server).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          integrationListeningPort = null;
        }),
      ),
    ),
);
export {
  processProbeFailure,
  TestProcessRunner,
  integrationListeningPort,
  TestIntegrationNet,
  makeProbeFailureLayer,
  TestPortDiscoveryLive,
  LSOF_TEST_PORT,
  makeLsofScannerLayer,
  openServer,
  closeServer,
  openCommonDevServer,
  commonDevServer,
  commonNonHttpServer,
};
