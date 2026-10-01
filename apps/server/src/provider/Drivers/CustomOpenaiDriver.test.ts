import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId } from "@akeru/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { FetchHttpClient } from "effect/unstable/http";

import { ServerConfig } from "../../config.ts";
import { BUILT_IN_DRIVERS } from "../builtInDrivers.ts";
import { CustomOpenaiDriver } from "./CustomOpenaiDriver.ts";

const DRIVER_KIND = ProviderDriverKind.make("customOpenai");
const INSTANCE_ID = ProviderInstanceId.make("customOpenai");

interface RecordedRequest {
  readonly url: string;
  readonly authorization: string | null;
}

const catalogFetch = (modelIds: ReadonlyArray<string>, recorded: RecordedRequest[] = []) =>
  ((
    input: Parameters<typeof globalThis.fetch>[0],
    init: Parameters<typeof globalThis.fetch>[1],
  ) => {
    const headers = new Headers(init?.headers ?? undefined);
    recorded.push({ url: String(input), authorization: headers.get("authorization") });
    return Promise.resolve(
      new Response(
        JSON.stringify({ object: "list", data: modelIds.map((id) => ({ id, object: "model" })) }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
  }) as typeof globalThis.fetch;

const failingCatalogFetch = ((input: Parameters<typeof globalThis.fetch>[0]) =>
  Promise.resolve(
    new Response(`no catalog at ${String(input)}`, {
      status: 503,
      headers: { "content-type": "text/plain" },
    }),
  )) as typeof globalThis.fetch;

const testLayer = (prefix: string, fetch: typeof globalThis.fetch) =>
  Layer.mergeAll(
    ServerConfig.layerTest(process.cwd(), { prefix }).pipe(Layer.provideMerge(NodeServices.layer)),
    FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch))),
  );

const createInstance = (input: {
  readonly config: Parameters<typeof CustomOpenaiDriver.create>[0]["config"];
  readonly environment?: Parameters<typeof CustomOpenaiDriver.create>[0]["environment"];
}) =>
  CustomOpenaiDriver.create({
    instanceId: INSTANCE_ID,
    displayName: undefined,
    environment: input.environment ?? [],
    enabled: true,
    config: input.config,
  });

describe("CustomOpenaiDriver", () => {
  it.effect("registers an endpoint-driven provider with no bundled models", () => {
    expect(BUILT_IN_DRIVERS.map((driver) => String(driver.driverKind))).toContain("customOpenai");
    const program = Effect.scoped(
      Effect.gen(function* () {
        const instance = yield* createInstance({
          config: CustomOpenaiDriver.defaultConfig(),
        });
        const snapshot = yield* instance.snapshot.getSnapshot;
        return { instance, snapshot };
      }),
    );
    return program.pipe(
      Effect.provide(testLayer("akeru-custom-openai-driver-test-", catalogFetch([]))),
      Effect.tap(({ instance, snapshot }) =>
        Effect.sync(() => {
          expect(instance.adapter).toBeUndefined();
          expect(instance.textGeneration).toBeUndefined();
          expect(instance.mastraConnection?.useSavedCredential).toBe(true);
          expect(snapshot).toMatchObject({
            instanceId: "customOpenai",
            driver: DRIVER_KIND,
            displayName: "Custom API",
            status: "warning",
            auth: { status: "unauthenticated", type: "apiKey" },
            models: [],
            message: "Set a base URL in Settings.",
          });
        }),
      ),
    );
  });

  it.effect("lists the endpoint catalog alongside hand-added models", () => {
    const recorded: RecordedRequest[] = [];
    const program = Effect.scoped(
      Effect.gen(function* () {
        const instance = yield* createInstance({
          config: {
            ...CustomOpenaiDriver.defaultConfig(),
            baseUrl: "https://api.example.com/v1/",
            apiKey: "sk-test",
            customModels: ["local-only", "gpt-4o-mini", "  "],
          },
        });
        const snapshot = yield* instance.snapshot.refresh;
        return { instance, snapshot };
      }),
    );
    return program.pipe(
      Effect.provide(
        testLayer(
          "akeru-custom-openai-catalog-test-",
          catalogFetch(["gpt-4o-mini", "llama-3.3"], recorded),
        ),
      ),
      Effect.tap(({ instance, snapshot }) =>
        Effect.sync(() => {
          expect(recorded).toHaveLength(1);
          expect(recorded[0]).toMatchObject({
            url: "https://api.example.com/v1/models",
            authorization: "Bearer sk-test",
          });
          expect(snapshot.status).toBe("ready");
          expect(snapshot.auth.status).toBe("authenticated");
          expect(snapshot.message).toBeUndefined();
          expect(snapshot.models).toMatchObject([
            { slug: "gpt-4o-mini", isCustom: false, isDefault: true },
            { slug: "llama-3.3", isCustom: false },
            { slug: "local-only", isCustom: true },
          ]);
          expect(instance.mastraConnection?.environment).toMatchObject({
            CUSTOM_OPENAI_API_KEY: "sk-test",
            CUSTOM_OPENAI_BASE_URL: "https://api.example.com/v1/",
          });
        }),
      ),
    );
  });

  it.effect("runs a keyless local endpoint and reports a failed catalog probe", () => {
    const program = Effect.scoped(
      Effect.gen(function* () {
        const instance = yield* createInstance({
          config: {
            ...CustomOpenaiDriver.defaultConfig(),
            baseUrl: "http://localhost:11434/v1",
            customModels: ["llama3.2"],
          },
        });
        return { instance, snapshot: yield* instance.snapshot.refresh };
      }),
    );
    return program.pipe(
      Effect.provide(testLayer("akeru-custom-openai-keyless-test-", failingCatalogFetch)),
      Effect.tap(({ instance, snapshot }) =>
        Effect.sync(() => {
          expect(snapshot.status).toBe("ready");
          expect(snapshot.auth).toMatchObject({ status: "authenticated", type: "apiKey" });
          expect(snapshot.message).toBe(
            "Model list from http://localhost:11434/v1 returned HTTP 503.",
          );
          expect(snapshot.models).toMatchObject([{ slug: "llama3.2", isCustom: true }]);
          expect(instance.mastraConnection?.environment.CUSTOM_OPENAI_API_KEY).toBeUndefined();
          expect(instance.mastraConnection?.environment).toMatchObject({
            CUSTOM_OPENAI_BASE_URL: "http://localhost:11434/v1",
          });
        }),
      ),
    );
  });

  it.effect("prefers instance environment variables over the settings blob", () => {
    const program = Effect.scoped(
      Effect.gen(function* () {
        const instance = yield* createInstance({
          config: {
            ...CustomOpenaiDriver.defaultConfig(),
            baseUrl: "https://config.invalid/v1",
            apiKey: "config-key",
          },
          environment: [
            {
              name: "CUSTOM_OPENAI_BASE_URL",
              value: "http://localhost:11434/v1",
              sensitive: false,
            },
            { name: "CUSTOM_OPENAI_API_KEY", value: "env-key", sensitive: true },
          ],
        });
        return { instance, snapshot: yield* instance.snapshot.getSnapshot };
      }),
    );
    return program.pipe(
      Effect.provide(testLayer("akeru-custom-openai-env-test-", catalogFetch([]))),
      Effect.tap(({ instance, snapshot }) =>
        Effect.sync(() => {
          expect(snapshot.auth.status).toBe("authenticated");
          expect(snapshot).not.toHaveProperty("message");
          expect(instance.mastraConnection?.environment).toMatchObject({
            CUSTOM_OPENAI_API_KEY: "env-key",
            CUSTOM_OPENAI_BASE_URL: "http://localhost:11434/v1",
          });
          expect(instance.mastraConnection?.instanceEnvironment).toMatchObject({
            CUSTOM_OPENAI_API_KEY: "env-key",
            CUSTOM_OPENAI_BASE_URL: "http://localhost:11434/v1",
          });
        }),
      ),
    );
  });
});
