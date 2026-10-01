import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/unstable/http";

import { type HttpReadinessFailure, waitForHttpReady } from "./httpReadiness.ts";

class ReadinessTestError extends Schema.TaggedErrorClass<ReadinessTestError>()(
  "ReadinessTestError",
  {
    message: Schema.String,
  },
) {}

describe("HTTP readiness failure classification", () => {
  it.effect("reports typed probe and overall timeouts while preserving diagnostic causes", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const failures: HttpReadinessFailure[] = [];
      const client = HttpClient.make(() =>
        Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
      );
      const fiber = yield* waitForHttpReady({
        baseUrl: "http://environment.example.test/",
        timeoutMs: 1_000,
        intervalMs: 100,
        probeTimeoutMs: 250,
        makeError: (failure) => {
          failures.push(failure);
          return new ReadinessTestError({ message: failure.kind });
        },
      }).pipe(Effect.flip, Effect.provideService(HttpClient.HttpClient, client), Effect.forkChild);

      yield* Deferred.await(started);
      yield* TestClock.adjust(1_000);
      expect((yield* Fiber.join(fiber)).message).toBe("overall-timeout");
      const probe = failures.find((failure) => failure.kind === "probe-timeout");
      expect(probe?.cause).toEqual({ kind: "probe-timeout", attempt: 1, probeTimeoutMs: 250 });
      const overall = failures.find((failure) => failure.kind === "overall-timeout");
      expect(overall?.cause.baseUrl).toBe("http://environment.example.test/");
      expect(overall?.cause.timeoutMs).toBe(1_000);
      expect(overall?.cause.lastFailure).toBeDefined();
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("passes request failures through without guessing a timeout from external fields", () =>
    Effect.gen(function* () {
      const failures: HttpReadinessFailure[] = [];
      let attempts = 0;
      const externalCause = { kind: "overall-timeout", timeoutMs: 123 };
      const client = HttpClient.make((request) => {
        attempts += 1;
        return attempts === 1
          ? Effect.fail(
              new HttpClientError.HttpClientError({
                reason: new HttpClientError.TransportError({ request, cause: externalCause }),
              }),
            )
          : Effect.succeed(HttpClientResponse.fromWeb(request, new Response("", { status: 200 })));
      });
      const fiber = yield* waitForHttpReady({
        baseUrl: "http://environment.example.test/",
        intervalMs: 100,
        makeError: (failure) => {
          failures.push(failure);
          return new ReadinessTestError({ message: failure.kind });
        },
      }).pipe(Effect.provideService(HttpClient.HttpClient, client), Effect.forkChild);

      yield* TestClock.adjust(100);
      yield* Fiber.join(fiber);
      expect(failures.map((failure) => failure.kind)).toEqual(["request-failure"]);
      const failure = failures[0];
      expect(failure?.cause).toBeInstanceOf(HttpClientError.HttpClientError);
    }).pipe(Effect.provide(TestClock.layer())),
  );
});
