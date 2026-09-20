import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { fetchRemoteEnvironmentDescriptor } from "./descriptor.ts";
import { remoteHttpClientLayer } from "../rpc/http.ts";

const DESCRIPTOR = {
  environmentId: "environment-remote",
  label: "Remote environment",
  platform: { os: "linux", arch: "x64" },
  serverVersion: "0.0.0-test",
  capabilities: { repositoryIdentity: true },
};

const AKERU_URL = "https://remote.example.com/.well-known/akeru/environment";
const T3_URL = "https://remote.example.com/.well-known/t3/environment";

const fetchByUrl = (handlers: Record<string, Response>) => {
  const calls: Array<string> = [];
  const fetchFn = ((input) => {
    const url = String(input);
    calls.push(url);
    const response = handlers[url];
    return Promise.resolve(response ?? new Response("not found", { status: 404 }));
  }) satisfies typeof fetch;
  return { fetchFn, calls };
};

describe("fetchRemoteEnvironmentDescriptor", () => {
  it.effect("probes the Akeru well-known path first", () =>
    Effect.gen(function* () {
      const fetch = fetchByUrl({
        [AKERU_URL]: Response.json({ ...DESCRIPTOR, label: "Akeru environment" }),
        [T3_URL]: Response.json({ ...DESCRIPTOR, label: "T3 environment" }),
      });

      const descriptor = yield* fetchRemoteEnvironmentDescriptor({
        httpBaseUrl: "https://remote.example.com/",
      }).pipe(Effect.provide(remoteHttpClientLayer(fetch.fetchFn)));

      expect(descriptor.label).toBe("Akeru environment");
      expect(fetch.calls).toEqual([AKERU_URL]);
    }),
  );

  it.effect("falls back to the T3 well-known path when Akeru is missing", () =>
    Effect.gen(function* () {
      const fetch = fetchByUrl({
        [T3_URL]: Response.json({ ...DESCRIPTOR, label: "T3 environment" }),
      });

      const descriptor = yield* fetchRemoteEnvironmentDescriptor({
        httpBaseUrl: "https://remote.example.com/",
      }).pipe(Effect.provide(remoteHttpClientLayer(fetch.fetchFn)));

      expect(descriptor.label).toBe("T3 environment");
      expect(fetch.calls).toEqual([AKERU_URL, T3_URL]);
    }),
  );

  it.effect("does not fall back when the Akeru path answers with an error", () =>
    Effect.gen(function* () {
      const fetch = fetchByUrl({
        [AKERU_URL]: Response.json({ message: "descriptor unavailable" }, { status: 503 }),
        [T3_URL]: Response.json(DESCRIPTOR),
      });

      const error = yield* fetchRemoteEnvironmentDescriptor({
        httpBaseUrl: "https://remote.example.com/",
      }).pipe(Effect.provide(remoteHttpClientLayer(fetch.fetchFn)), Effect.flip);

      expect(error).toMatchObject({
        _tag: "RemoteEnvironmentAuthUndeclaredStatusError",
        status: 503,
        requestUrl: AKERU_URL,
      });
      expect(fetch.calls).toEqual([AKERU_URL]);
    }),
  );
});
