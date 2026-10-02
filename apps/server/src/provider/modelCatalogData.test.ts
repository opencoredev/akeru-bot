import { assert, describe, it } from "@effect/vitest";
import { ProviderDriverKind } from "@akeru/contracts";

import {
  BUNDLED_MODEL_CATALOG,
  catalogFromModelsDev,
  catalogModelsFor,
  currentModelIds,
  harnessEffortLevels,
  mergeCatalogs,
  type ModelCatalogData,
} from "./modelCatalogData.ts";

const CODEX = ProviderDriverKind.make("codex");

const CLAUDE = ProviderDriverKind.make("claudeAgent");

const KIMI = ProviderDriverKind.make("kimi");

const CURSOR = ProviderDriverKind.make("cursor");

const effort = (values: ReadonlyArray<string>) => [{ type: "effort", values }];

/** A trimmed models.dev payload covering each filter the conversion applies. */
const MODELS_DEV_PAYLOAD = {
  openai: {
    models: {
      "gpt-next": {
        id: "gpt-next",
        name: "GPT Next",
        family: "gpt-next",
        release_date: "2026-09-01",
        tool_call: true,
        reasoning_options: effort(["none", "low", "medium", "high", "xhigh"]),
        experimental: { modes: { fast: { provider: { body: { service_tier: "priority" } } } } },
      },
      "gpt-old": {
        id: "gpt-old",
        name: "GPT Old",
        family: "gpt-next",
        release_date: "2026-03-01",
        tool_call: true,
        reasoning_options: effort(["low", "medium", "high"]),
      },
      "gpt-next-pro": {
        id: "gpt-next-pro",
        name: "GPT Next Pro",
        family: "gpt-next-pro",
        tool_call: true,
        reasoning_options: effort(["high"]),
      },
      "gpt-chat": { id: "gpt-chat", name: "GPT Chat", tool_call: true },
      "gpt-image": {
        id: "gpt-image",
        name: "GPT Image",
        tool_call: true,
        reasoning_options: effort(["low"]),
        modalities: { output: ["image"] },
      },
      o9: { id: "o9", name: "o9", tool_call: true, reasoning_options: effort(["low"]) },
      broken: { id: 42 },
    },
  },
  anthropic: {
    models: {
      "claude-next": {
        id: "claude-next",
        name: "Claude Next",
        family: "claude-opus",
        release_date: "2026-09-01",
        tool_call: true,
      },
      "claude-next-20260901": {
        id: "claude-next-20260901",
        name: "Claude Next (dated)",
        tool_call: true,
      },
      "claude-ancient": {
        id: "claude-ancient",
        name: "Claude Ancient",
        family: "claude-haiku",
        release_date: "2025-01-01",
        tool_call: true,
      },
      "claude-retired": {
        id: "claude-retired",
        name: "Claude Retired",
        family: "claude-sonnet",
        release_date: "2026-08-01",
        status: "deprecated",
        tool_call: true,
      },
    },
  },
  "kimi-code-plan-global": {
    models: {
      k9: { id: "k9", name: "Kimi K9", tool_call: true },
      k8: { id: "k8", name: "Kimi K8", tool_call: true, status: "deprecated" },
    },
  },
};

const catalog = catalogFromModelsDev(MODELS_DEV_PAYLOAD)!;

const ids = (driver: ProviderDriverKind, from: ModelCatalogData = catalog) =>
  catalogModelsFor(from, driver).map((model) => model.id);

describe("catalogFromModelsDev", () => {
  it("keeps ChatGPT reasoning models and drops Pro, non-reasoning, non-text, and non-GPT ones", () => {
    assert.deepStrictEqual(ids(CODEX), ["gpt-next", "gpt-old"]);
    assert.deepStrictEqual(catalogModelsFor(catalog, CODEX)[0], {
      id: "gpt-next",
      name: "GPT Next",
      family: "gpt-next",
      releaseDate: "2026-09-01",
      efforts: ["none", "low", "medium", "high", "xhigh"],
      fast: true,
    });
  });

  it("drops dated Claude snapshots and orders models newest first", () => {
    assert.deepStrictEqual(ids(CLAUDE), ["claude-next", "claude-retired", "claude-ancient"]);
  });

  it("returns null when no covered provider has a usable model", () => {
    assert.isNull(catalogFromModelsDev({ openai: { models: {} } }));
  });

  it("keeps a driver's previous models when a refresh omits it", () => {
    const merged = mergeCatalogs(BUNDLED_MODEL_CATALOG, catalog);
    assert.deepStrictEqual(ids(CODEX, merged), ["gpt-next", "gpt-old"]);
    assert.deepStrictEqual(
      ids(ProviderDriverKind.make("grok"), merged),
      ids(ProviderDriverKind.make("grok"), BUNDLED_MODEL_CATALOG),
    );
  });
});

describe("currentModelIds", () => {
  it("keeps the newest recent model of each family and never a deprecated one", () => {
    assert.deepStrictEqual([...currentModelIds(catalog, CODEX)!], ["gpt-next"]);
    assert.deepStrictEqual([...currentModelIds(catalog, CLAUDE)!], ["claude-next"]);
  });

  it("treats every non-deprecated model as current for plan providers", () => {
    assert.deepStrictEqual([...currentModelIds(catalog, KIMI)!], ["k9"]);
  });

  it("returns null for drivers the catalog does not cover", () => {
    assert.isNull(currentModelIds(catalog, CURSOR));
  });

  it("keeps GPT-6.1 Sol and Claude Opus 5.5 current in the bundled catalog", () => {
    assert.isTrue(currentModelIds(BUNDLED_MODEL_CATALOG, CODEX)!.has("gpt-6.1-sol"));
    assert.isTrue(currentModelIds(BUNDLED_MODEL_CATALOG, CLAUDE)!.has("claude-opus-5-5"));
    assert.isFalse(currentModelIds(BUNDLED_MODEL_CATALOG, CLAUDE)!.has("claude-opus-5"));
  });
});

describe("harnessEffortLevels", () => {
  it("maps models.dev efforts onto Mastra thinking levels", () => {
    assert.deepStrictEqual(harnessEffortLevels(["none", "minimal", "low", "medium", "xhigh"]), [
      "off",
      "low",
      "medium",
      "xhigh",
    ]);
  });
});
