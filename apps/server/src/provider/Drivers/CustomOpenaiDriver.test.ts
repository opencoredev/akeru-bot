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

const API_KEY_ENV = "CUSTOM_OPENAI_API_KEY";

const BASE_URL_ENV = "CUSTOM_OPENAI_BASE_URL";

interface RecordedRequest {
  readonly url: string;
  readonly authorization: string | null;
}

/** A `/models` endpoint whose answers the test flips between phases. */
const catalogEndpoint = (responses: ReadonlyArray<Response>, recorded: RecordedRequest[] = []) => {
  let index = 0;

  return ((
    input: Parameters<typeof globalThis.fetch>[0],
    init: Parameters<typeof globalThis.fetch>[1],
  ) => {
    const headers = new Headers(init?.headers ?? undefined);
    recorded.push({ url: String(input), authorization: headers.get("authorization") });
    const response = responses[Math.min(index, responses.length - 1)]!;
    index += 1;

    return Promise.resolve(response.clone());
  }) as typeof globalThis.fetch;
};

const modelListResponse = (modelIds: ReadonlyArray<string>) =>
  new Response(
    JSON.stringify({ object: "list", data: modelIds.map((id) => ({ id, object: "model" })) }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

const failingResponse = () =>
  new Response("upstream unavailable", { status: 503, headers: { "content-type": "text/plain" } });

const rejectedResponse = () =>
  new Response('{"error":"invalid api key"}', {
    status: 401,
    headers: { "content-type": "application/json" },
  });

const unreadableResponse = () =>
  new Response("<html>not json</html>", { status: 200, headers: { "content-type": "text/html" } });

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

const withApiKey = (name: string, value: string) => ({ name, value, sensitive: true });

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
      Effect.provide(testLayer("akeru-custom-openai-driver-test-", catalogEndpoint([]))),
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
            customModels: ["local-only", "gpt-4o-mini", "  "],
          },
          environment: [withApiKey(API_KEY_ENV, "sk-test")],
        });

        const snapshot = yield* instance.snapshot.refresh;

        return { instance, snapshot };
      }),
    );

    return program.pipe(
      Effect.provide(
        testLayer(
          "akeru-custom-openai-catalog-test-",
          catalogEndpoint([modelListResponse(["gpt-4o-mini", "llama-3.3"])], recorded),
        ),
      ),
      Effect.tap(({ instance, snapshot }) =>
        Effect.sync(() => {
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
            [API_KEY_ENV]: "sk-test",
            [BASE_URL_ENV]: "https://api.example.com/v1/",
          });
        }),
      ),
    );
  });

  it.effect("keeps the last good catalog when a probe fails", () => {
    const recorded: RecordedRequest[] = [];

    const program = Effect.scoped(
      Effect.gen(function* () {
        const instance = yield* createInstance({
          config: {
            ...CustomOpenaiDriver.defaultConfig(),
            baseUrl: "https://user:pass@api.example.com/v1/gateway-token",
          },
        });

        const good = yield* instance.snapshot.refresh;
        const failed = yield* instance.snapshot.refresh;

        return { good, failed };
      }),
    );

    return program.pipe(
      Effect.provide(
        testLayer(
          "akeru-custom-openai-retain-test-",
          catalogEndpoint([modelListResponse(["alpha", "beta"]), failingResponse()], recorded),
        ),
      ),
      Effect.tap(({ good, failed }) =>
        Effect.sync(() => {
          expect(good.models.map((model) => model.slug)).toEqual(["alpha", "beta"]);
          expect(good.status).toBe("ready");
          // The endpoint is now unreachable: the catalog survives, and the
          // snapshot stops claiming to be authoritative.
          expect(failed.models.map((model) => model.slug)).toEqual(["alpha", "beta"]);
          expect(failed.status).toBe("warning");
          // Only the origin is published; credentials and paths stay private.
          expect(failed.message).toBe("Model list from https://api.example.com returned HTTP 503.");
        }),
      ),
    );
  });

  it.effect("flags a refused model listing without blocking the instance", () => {
    const program = Effect.scoped(
      Effect.gen(function* () {
        const instance = yield* createInstance({
          config: { ...CustomOpenaiDriver.defaultConfig(), baseUrl: "https://api.example.com/v1" },
          environment: [withApiKey(API_KEY_ENV, "sk-wrong")],
        });

        const rejected = yield* instance.snapshot.refresh;
        const recovered = yield* instance.snapshot.refresh;

        return { rejected, recovered };
      }),
    );

    return program.pipe(
      Effect.provide(
        testLayer(
          "akeru-custom-openai-rejected-test-",
          catalogEndpoint([rejectedResponse(), modelListResponse(["alpha"])]),
        ),
      ),
      Effect.tap(({ rejected, recovered }) =>
        Effect.sync(() => {
          expect(rejected.status).toBe("warning");
          expect(rejected.auth.status).toBe("unknown");
          expect(rejected.message).toBe(
            "https://api.example.com refused to list models (HTTP 401). Check the API key in Settings.",
          );
          expect(recovered.auth.status).toBe("authenticated");
          expect(recovered.status).toBe("ready");
        }),
      ),
    );
  });

  it.effect("never contacts the endpoint while the instance is disabled", () => {
    const recorded: RecordedRequest[] = [];

    const program = Effect.scoped(
      Effect.gen(function* () {
        const instance = yield* createInstance({
          config: {
            ...CustomOpenaiDriver.defaultConfig(),
            enabled: false,
            baseUrl: "https://api.example.com/v1",
          },
          environment: [withApiKey(API_KEY_ENV, "sk-test")],
        });

        return yield* instance.snapshot.refresh;
      }),
    );

    return program.pipe(
      Effect.provide(
        testLayer(
          "akeru-custom-openai-disabled-test-",
          catalogEndpoint([modelListResponse(["alpha"])], recorded),
        ),
      ),
      Effect.tap((snapshot) =>
        Effect.sync(() => {
          expect(snapshot.status).toBe("disabled");
          expect(recorded).toEqual([]);
        }),
      ),
    );
  });

  it.effect("treats an unreadable model list as a failed probe", () => {
    const program = Effect.scoped(
      Effect.gen(function* () {
        const instance = yield* createInstance({
          config: {
            ...CustomOpenaiDriver.defaultConfig(),
            baseUrl: "http://localhost:11434/v1",
            customModels: ["llama3.2"],
          },
        });

        return yield* instance.snapshot.refresh;
      }),
    );

    return program.pipe(
      Effect.provide(
        testLayer("akeru-custom-openai-unreadable-test-", catalogEndpoint([unreadableResponse()])),
      ),
      Effect.tap((snapshot) =>
        Effect.sync(() => {
          expect(snapshot.status).toBe("warning");
          expect(snapshot.message).toBe(
            "Model list from http://localhost:11434 was not a readable list of models.",
          );
          // A keyless local endpoint still runs turns; only the catalog is unknown.
          expect(snapshot.auth).toMatchObject({ status: "authenticated", type: "apiKey" });
          expect(snapshot.models).toMatchObject([{ slug: "llama3.2", isCustom: true }]);
        }),
      ),
    );
  });

  it.effect("ignores process-level endpoint variables", () => {
    const previousKey = process.env[API_KEY_ENV];
    const previousUrl = process.env[BASE_URL_ENV];
    process.env[API_KEY_ENV] = "process-wide-key";
    process.env[BASE_URL_ENV] = "https://process.invalid/v1";

    const program = Effect.scoped(
      Effect.gen(function* () {
        const instance = yield* createInstance({
          config: CustomOpenaiDriver.defaultConfig(),
        });

        return { instance, snapshot: yield* instance.snapshot.getSnapshot };
      }),
    );

    return program.pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (previousKey === undefined) delete process.env[API_KEY_ENV];
          else process.env[API_KEY_ENV] = previousKey;

          if (previousUrl === undefined) delete process.env[BASE_URL_ENV];
          else process.env[BASE_URL_ENV] = previousUrl;
        }),
      ),
      Effect.provide(testLayer("akeru-custom-openai-ambient-test-", catalogEndpoint([]))),
      Effect.tap(({ instance, snapshot }) =>
        Effect.sync(() => {
          // An instance that configures neither would otherwise send the
          // process key to the process endpoint.
          expect(instance.mastraConnection?.environment).not.toHaveProperty(API_KEY_ENV);
          expect(instance.mastraConnection?.environment).not.toHaveProperty(BASE_URL_ENV);
          expect(snapshot.status).toBe("warning");
          expect(snapshot.message).toBe("Set a base URL in Settings.");
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
          },
          environment: [
            { name: BASE_URL_ENV, value: "http://localhost:11434/v1", sensitive: false },
            withApiKey(API_KEY_ENV, "env-key"),
          ],
        });

        return { instance, snapshot: yield* instance.snapshot.getSnapshot };
      }),
    );

    return program.pipe(
      Effect.provide(testLayer("akeru-custom-openai-env-test-", catalogEndpoint([]))),
      Effect.tap(({ instance, snapshot }) =>
        Effect.sync(() => {
          expect(snapshot.auth.status).toBe("authenticated");
          expect(instance.mastraConnection?.environment).toMatchObject({
            [API_KEY_ENV]: "env-key",
            [BASE_URL_ENV]: "http://localhost:11434/v1",
          });
          expect(instance.mastraConnection?.instanceEnvironment).toMatchObject({
            [API_KEY_ENV]: "env-key",
            [BASE_URL_ENV]: "http://localhost:11434/v1",
          });
        }),
      ),
    );
  });
});
