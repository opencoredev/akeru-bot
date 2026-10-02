/**
 * Pure half of the model catalog: turns the models.dev API payload into the
 * small per-driver catalog Akeru keeps, and decides which models are current.
 *
 * `ModelCatalog.ts` fetches and caches; `scripts/sync-model-catalog.ts`
 * regenerates the bundled `model-catalog.json` with the same conversion.
 */
import type { ProviderDriverKind } from "@akeru/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import bundledCatalogJson from "./model-catalog.json" with { type: "json" };

export const MODELS_DEV_URL = "https://models.dev/api.json";

/** models.dev provider id for each driver kind the catalog covers. */
export const MODELS_DEV_PROVIDER_BY_DRIVER = {
  codex: "openai",
  claudeAgent: "anthropic",
  grok: "xai",
  kimi: "kimi-code-plan-global",
  opencodeGo: "opencode-go",
} as const satisfies Record<string, string>;

/**
 * Drivers whose older models move to the picker's legacy section. Kimi For
 * Coding and OpenCode Go plans list every model they serve as current.
 */
const DRIVERS_WITH_LEGACY: ReadonlySet<string> = new Set(["codex", "claudeAgent", "grok"]);

/** A family's newest model stays current while it is this close to the
 * provider's newest release. Measured against the newest release, not the
 * clock, so an old cache or bundle never demotes everything. */
const CURRENT_WINDOW_MS = 180 * 24 * 60 * 60 * 1000;

const CatalogModel = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  family: Schema.optionalKey(Schema.String),
  releaseDate: Schema.optionalKey(Schema.String),
  deprecated: Schema.optionalKey(Schema.Boolean),
  /** Reasoning effort levels the model accepts, in models.dev order. */
  efforts: Schema.optionalKey(Schema.Array(Schema.String)),
  /** True when the model offers a priority (Fast) service tier. */
  fast: Schema.optionalKey(Schema.Boolean),
});

export type CatalogModel = typeof CatalogModel.Type;

/** `version` gates breaking changes to the cached and bundled shape. */
export const ModelCatalogSchema = Schema.Struct({
  version: Schema.Literal(1),
  drivers: Schema.Record(Schema.String, Schema.Array(CatalogModel)),
});

export type ModelCatalogData = typeof ModelCatalogSchema.Type;

export const BUNDLED_MODEL_CATALOG: ModelCatalogData =
  Schema.decodeUnknownSync(ModelCatalogSchema)(bundledCatalogJson);

/** The slice of a models.dev model entry the catalog reads. Unknown keys are ignored. */
const ModelsDevModel = Schema.Struct({
  id: Schema.String,
  name: Schema.optionalKey(Schema.String),
  family: Schema.optionalKey(Schema.String),
  release_date: Schema.optionalKey(Schema.String),
  status: Schema.optionalKey(Schema.String),
  tool_call: Schema.optionalKey(Schema.Boolean),
  reasoning_options: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        type: Schema.String,
        values: Schema.optionalKey(Schema.Array(Schema.String)),
      }),
    ),
  ),
  modalities: Schema.optionalKey(
    Schema.Struct({ output: Schema.optionalKey(Schema.Array(Schema.String)) }),
  ),
  experimental: Schema.optionalKey(
    Schema.Struct({
      modes: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
    }),
  ),
});

type ModelsDevModel = typeof ModelsDevModel.Type;

const ModelsDevProvider = Schema.Struct({
  models: Schema.Record(Schema.String, Schema.Unknown),
});

const decodeModelsDevModel = Schema.decodeUnknownOption(ModelsDevModel);

const decodeModelsDevProvider = Schema.decodeUnknownOption(ModelsDevProvider);

/** The models.dev payload: provider entries keyed by provider id. Each entry
 * and model is decoded on its own so one malformed record cannot sink the rest. */
export const ModelsDevPayload = Schema.Record(Schema.String, Schema.Unknown);

export type ModelsDevPayload = typeof ModelsDevPayload.Type;

/** Whether a driver can run this models.dev entry as a coding agent model. */
function isUsable(driver: string, model: ModelsDevModel): boolean {
  if (model.tool_call !== true) return false;

  if ((model.modalities?.output ?? ["text"]).some((output) => output !== "text")) return false;

  // Dated Anthropic snapshots duplicate their undated alias.
  if (driver === "claudeAgent" && /-\d{8}$/.test(model.id)) return false;

  if (driver === "codex") {
    // ChatGPT sign-in serves the GPT reasoning models. The Pro and nano tiers
    // are API-only, and non-reasoning models do not run in the Codex harness.
    const efforts = model.reasoning_options?.find((option) => option.type === "effort");

    return (
      model.id.startsWith("gpt-") &&
      !/-(pro|nano)$/.test(model.family ?? "") &&
      efforts !== undefined
    );
  }

  return true;
}

function toCatalogModel(model: ModelsDevModel): CatalogModel {
  const efforts = model.reasoning_options?.find((option) => option.type === "effort")?.values;

  return {
    id: model.id,
    name: model.name?.trim() || model.id,
    ...(model.family ? { family: model.family } : {}),
    ...(model.release_date ? { releaseDate: model.release_date } : {}),
    ...(model.status === "deprecated" ? { deprecated: true } : {}),
    ...(efforts && efforts.length > 0 ? { efforts } : {}),
    ...(model.experimental?.modes?.fast !== undefined ? { fast: true } : {}),
  };
}

const releaseMs = (model: CatalogModel) => Date.parse(model.releaseDate ?? "") || 0;

/** Newest release first; ties keep a stable id order. */
const byNewest = (left: CatalogModel, right: CatalogModel) =>
  releaseMs(right) - releaseMs(left) || left.id.localeCompare(right.id);

/**
 * Converts the models.dev payload into the catalog. Returns null when the
 * payload holds no usable model for any covered driver, so a broken or
 * reshaped upstream response never replaces a good catalog.
 */
export function catalogFromModelsDev(providers: ModelsDevPayload): ModelCatalogData | null {
  const drivers: Record<string, ReadonlyArray<CatalogModel>> = {};

  for (const [driver, providerId] of Object.entries(MODELS_DEV_PROVIDER_BY_DRIVER)) {
    const provider = Option.getOrUndefined(decodeModelsDevProvider(providers[providerId]));

    if (provider === undefined) continue;

    const models = Object.values(provider.models).flatMap((raw) => {
      const decoded = Option.getOrUndefined(decodeModelsDevModel(raw));

      return decoded !== undefined && isUsable(driver, decoded) ? [toCatalogModel(decoded)] : [];
    });

    if (models.length > 0) drivers[driver] = models.toSorted(byNewest);
  }

  return Object.keys(drivers).length > 0 ? { version: 1, drivers } : null;
}

/**
 * Combines a fresh catalog with the previous one: a driver missing from the
 * fresh payload keeps its previous models instead of losing its list.
 */
export function mergeCatalogs(
  previous: ModelCatalogData,
  next: ModelCatalogData,
): ModelCatalogData {
  return { version: 1, drivers: { ...previous.drivers, ...next.drivers } };
}

/** Catalog models for a driver, newest first. Empty for drivers the catalog does not cover. */
export function catalogModelsFor(
  catalog: ModelCatalogData,
  driver: ProviderDriverKind,
): ReadonlyArray<CatalogModel> {
  return catalog.drivers[driver] ?? [];
}

/**
 * Model ids that belong in the picker's main section, or null when the driver
 * has no legacy concept. Deprecated models are never current. For drivers with
 * a legacy section, only the newest model of each family stays current, and
 * only while its release is recent relative to the provider's newest model.
 */
export function currentModelIds(
  catalog: ModelCatalogData,
  driver: ProviderDriverKind,
): ReadonlySet<string> | null {
  const models = catalogModelsFor(catalog, driver).filter((model) => !model.deprecated);

  if (!DRIVERS_WITH_LEGACY.has(driver)) {
    return catalog.drivers[driver] ? new Set(models.map((model) => model.id)) : null;
  }

  if (models.length === 0) return null;
  const newest = Math.max(...models.map(releaseMs));
  const newestByFamily = new Map<string, CatalogModel>();

  for (const model of models.toSorted(byNewest)) {
    const family = model.family ?? model.id;

    if (!newestByFamily.has(family)) newestByFamily.set(family, model);
  }

  return new Set(
    [...newestByFamily.values()].flatMap((model) =>
      newest - releaseMs(model) <= CURRENT_WINDOW_MS ? [model.id] : [],
    ),
  );
}

/** Maps models.dev effort names onto the levels the Mastra harness accepts. */
export function harnessEffortLevels(efforts: ReadonlyArray<string>): string[] {
  return [
    ...new Set(
      efforts.flatMap((effort) =>
        effort === "none"
          ? ["off"]
          : ["low", "medium", "high", "xhigh", "max"].includes(effort)
            ? [effort]
            : [],
      ),
    ),
  ];
}
