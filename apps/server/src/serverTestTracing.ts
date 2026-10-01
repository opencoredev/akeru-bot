import * as Predicate from "effect/Predicate";
// @effect-diagnostics globalDate:off nodeBuiltinImport:off
import * as Duration from "effect/Duration";

import * as Effect from "effect/Effect";

import * as Layer from "effect/Layer";

import * as ManagedRuntime from "effect/ManagedRuntime";

import { FetchHttpClient, HttpClient } from "effect/unstable/http";

import { OtlpSerialization, OtlpTracer } from "effect/unstable/observability";

export const browserOtlpTracingLayer = Layer.mergeAll(
  FetchHttpClient.layer,
  OtlpSerialization.layerJson,
  Layer.succeed(HttpClient.TracerDisabledWhen, () => true),
);

export const makeBrowserOtlpPayload = (spanName: string) =>
  Effect.gen(function* () {
    const collector = yield* Effect.acquireRelease(
      Effect.promise(async () => {
        const NodeHttp = await import("node:http");

        return await new Promise<{
          readonly close: () => Promise<void>;
          readonly firstRequest: Promise<{
            readonly body: string;
            readonly contentType: string | null;
          }>;
          readonly url: string;
        }>((resolve, reject) => {
          let resolveFirstRequest:
            | ((request: { readonly body: string; readonly contentType: string | null }) => void)
            | undefined;

          const firstRequest = new Promise<{
            readonly body: string;
            readonly contentType: string | null;
          }>((resolveRequest) => {
            resolveFirstRequest = resolveRequest;
          });

          const server = NodeHttp.createServer((request, response) => {
            const chunks: Buffer[] = [];
            request.on("data", (chunk) => {
              chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            });
            request.on("end", () => {
              resolveFirstRequest?.({
                body: Buffer.concat(chunks).toString("utf8"),
                contentType: request.headers["content-type"] ?? null,
              });
              resolveFirstRequest = undefined;
              response.statusCode = 204;
              response.end();
            });
          });

          server.on("error", reject);
          server.listen(0, "127.0.0.1", () => {
            const address = server.address();

            if (!address || Predicate.isString(address)) {
              reject(new Error("Expected TCP collector address"));

              return;
            }

            resolve({
              url: `http://127.0.0.1:${address.port}/v1/traces`,
              firstRequest,
              close: () =>
                new Promise<void>((resolveClose, rejectClose) => {
                  server.close((error) => {
                    if (error) {
                      rejectClose(error);

                      return;
                    }

                    resolveClose();
                  });
                }),
            });
          });
        });
      }),
      ({ close }) => Effect.promise(close),
    );

    const runtime = ManagedRuntime.make(
      OtlpTracer.layer({
        url: collector.url,
        exportInterval: "10 millis",
        resource: {
          serviceName: "t3-web",
          attributes: {
            "service.runtime": "t3-web",
            "service.mode": "browser",
            "service.version": "test",
          },
        },
      }).pipe(Layer.provide(browserOtlpTracingLayer)),
    );

    try {
      yield* Effect.promise(() => runtime.runPromise(Effect.void.pipe(Effect.withSpan(spanName))));
    } finally {
      yield* Effect.promise(() => runtime.dispose());
    }

    const request = yield* Effect.raceFirst(
      Effect.promise(() => collector.firstRequest).pipe(Effect.orDie),
      Effect.sleep(Duration.seconds(1)).pipe(
        Effect.andThen(Effect.die(new Error("Timed out waiting for OTLP trace export"))),
      ),
    );

    // SAFETY: The test collector receives JSON from the OTLP exporter and reads its TraceData wire fields.
    // @effect-diagnostics-next-line preferSchemaOverJson:off
    return JSON.parse(request.body) as OtlpTracer.TraceData;
  });
