import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderDriverKind, type ServerProviderModel } from "@akeru/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import { catalogProviderModels, classifyModels, isLegacyModel, make } from "./ModelCatalog.ts";
import { BUNDLED_MODEL_CATALOG, type ModelCatalogData } from "./modelCatalogData.ts";

const CODEX = ProviderDriverKind.make("codex");

const KIMI = ProviderDriverKind.make("kimi");

const CURSOR = ProviderDriverKind.make("cursor");

describe("isLegacyModel (bundled catalog)", () => {
  it("leaves driver kinds the catalog does not cover unflagged", () => {
    assert.isFalse(isLegacyModel(BUNDLED_MODEL_CATALOG, CURSOR, "composer-1.5"));
  });
});

const model = (overrides: Partial<ServerProviderModel>): ServerProviderModel => ({
  slug: "gpt-test",
  name: "GPT Test",
  isCustom: false,
  capabilities: null,
  ...overrides,
});

describe("classifyModels", () => {
  it("flags non-current models, clears stale flags, and skips custom models", () => {
    const models = [
      model({ slug: "gpt-6.1-sol" }),
      // Stale flag from a previous classification pass must be cleared.
      model({ slug: "gpt-6-luna", isLegacy: true }),
      model({ slug: "gpt-5.4" }),
      // Custom models are user-defined and never reclassified.
      model({ slug: "my-own-model", isCustom: true }),
    ];

    assert.deepStrictEqual(
      classifyModels(models, BUNDLED_MODEL_CATALOG, CODEX).map((entry) => [
        entry.slug,
        entry.isLegacy ?? false,
      ]),
      [
        ["gpt-6.1-sol", false],
        ["gpt-6-luna", false],
        ["gpt-5.4", true],
        ["my-own-model", false],
      ],
    );
  });
});

describe("catalogProviderModels", () => {
  it("names catalog models, keeps the fallback default, and appends custom models", () => {
    const catalog: ModelCatalogData = {
      version: 1,
      drivers: {
        kimi: [
          { id: "k9", name: "Kimi K9" },
          { id: "k8", name: "Kimi K8", deprecated: true },
        ],
      },
    };

    assert.deepStrictEqual(
      catalogProviderModels({
        catalog,
        driver: KIMI,
        fallbackSlugs: ["k8", "k7"],
        customModels: [" mine ", "k9", ""],
      }).map((entry) => [
        entry.slug,
        entry.name,
        entry.isDefault ?? false,
        entry.isLegacy ?? false,
      ]),
      [
        ["k9", "Kimi K9", false, false],
        // The default stays selectable as current even when models.dev retires it.
        ["k8", "Kimi K8", true, false],
        ["k7", "k7", false, true],
        ["mine", "mine", false, false],
      ],
    );
  });
});

/** models.dev payload whose only ChatGPT model is `gpt-remote`. */
const MODELS_DEV_PAYLOAD = {
  openai: {
    models: {
      "gpt-remote": {
        id: "gpt-remote",
        name: "GPT Remote",
        release_date: "2099-01-01",
        tool_call: true,
        reasoning_options: [{ type: "effort", values: ["low", "medium"] }],
      },
    },
  },
};

const httpClientLayer = (handler: () => Response) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request, handler()))),
  );

const serviceLayers = (input: {
  readonly prefix: string;
  readonly response: () => Response;
  readonly settings?: Parameters<typeof ServerSettings.layerTest>[0];
}) =>
  ServerConfig.layerTest(process.cwd(), { prefix: input.prefix }).pipe(
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(ServerSettings.layerTest(input.settings ?? {})),
    Layer.provideMerge(httpClientLayer(input.response)),
  );

describe("ModelCatalog service", () => {
  it.live("prefers a fetched catalog over the bundle and caches it to disk", () =>
    Effect.gen(function* () {
      const service = yield* make;
      const refreshed = yield* service.refresh;
      assert.deepStrictEqual(
        refreshed.drivers.codex?.map((entry) => entry.id),
        ["gpt-remote"],
      );
      // Drivers missing from the fetch keep their bundled models.
      assert.deepStrictEqual(refreshed.drivers.grok, BUNDLED_MODEL_CATALOG.drivers.grok);
      assert.isTrue(isLegacyModel(refreshed, CODEX, "gpt-6.1-sol"));
      assert.isFalse(isLegacyModel(refreshed, CODEX, "gpt-remote"));

      // A fresh service instance sees the disk cache without another fetch:
      // its HTTP layer is still stubbed, but `current` never fetches at all.
      const rebooted = yield* make;
      assert.deepStrictEqual(yield* rebooted.current, refreshed);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        serviceLayers({
          prefix: "model-catalog-fetch-test",
          response: () => Response.json(MODELS_DEV_PAYLOAD),
        }),
      ),
    ),
  );

  it.live("uses the bundled list for a driver whose disk cache predates the bundle", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;

      yield* fileSystem.makeDirectory(config.stateDir, { recursive: true });
      yield* fileSystem.writeFileString(
        NodePath.join(config.stateDir, "model-catalog.json"),
        JSON.stringify({
          fetchedAtMs: Date.now(),
          catalog: {
            version: 1,
            drivers: {
              codex: [{ id: "gpt-cached", name: "GPT Cached", releaseDate: "2020-01-01" }],
              kimi: [{ id: "k-cached", name: "Kimi Cached", releaseDate: "2099-01-01" }],
            },
          },
        }),
      );

      const current = yield* (yield* make).current;

      assert.deepStrictEqual(current.drivers.codex, BUNDLED_MODEL_CATALOG.drivers.codex);
      assert.deepStrictEqual(
        current.drivers.kimi?.map((entry) => entry.id),
        ["k-cached"],
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(
        serviceLayers({
          prefix: "model-catalog-old-cache-test",
          response: () => Response.json(MODELS_DEV_PAYLOAD),
        }),
      ),
    ),
  );

  it.live("keeps the bundled catalog when the models.dev payload is unusable", () =>
    Effect.gen(function* () {
      const service = yield* make;
      assert.deepStrictEqual(yield* service.refresh, BUNDLED_MODEL_CATALOG);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        serviceLayers({
          prefix: "model-catalog-malformed-test",
          response: () => Response.json({ version: 999, nonsense: true }),
        }),
      ),
    ),
  );

  it.live("does not fetch when provider update checks are disabled", () =>
    Effect.gen(function* () {
      let fetchCount = 0;

      const service = yield* make.pipe(
        Effect.provide(
          httpClientLayer(() => {
            fetchCount += 1;

            return Response.json(MODELS_DEV_PAYLOAD);
          }),
        ),
      );

      assert.deepStrictEqual(yield* service.refresh, BUNDLED_MODEL_CATALOG);
      assert.strictEqual(fetchCount, 0);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        serviceLayers({
          prefix: "model-catalog-optout-test",
          response: () => Response.json(MODELS_DEV_PAYLOAD),
          settings: { enableProviderUpdateChecks: false },
        }),
      ),
    ),
  );
});
