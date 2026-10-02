import type { MutableProviderConfig } from "./providerConfig";
import { providerConfig, type ProviderConfig } from "./providerConfig";
import type { ProviderInstanceConfig } from "@akeru/contracts";
import { Predicate } from "effect";
import * as Arr from "effect/Array";
import * as Result from "effect/Result";
import { type ServerProviderModel } from "@akeru/contracts";

/**
 * Read a string[] at `key` from the opaque config blob, filtering out
 * non-string entries. Used for `customModels`, which is always typed as
 * `string[]` by the concrete driver schemas but arrives here as
 * `Schema.Unknown`.
 */
export function readConfigStringArray(
  config: ProviderInstanceConfig["config"],
  key: string,
): ReadonlyArray<string> {
  const value = providerConfig(config)[key];

  if (!Array.isArray(value)) return [];

  return value.filter((entry): entry is string => Predicate.isString(entry));
}

/**
 * Set `key` to an arbitrary value on the opaque config blob. Unlike
 * provider settings field updates, does not drop empty-looking values — the
 * caller is responsible for deciding whether an empty array / empty
 * object should be stored explicitly (e.g. `customModels: []` is a
 * meaningful "user cleared their custom list" state distinct from
 * "driver default").
 */
export function nextConfigBlobWithValue(
  config: ProviderInstanceConfig["config"],
  key: string,
  value: ProviderConfig[string],
): ProviderConfig {
  const base: MutableProviderConfig = { ...providerConfig(config) };

  base[key] = value;

  return base;
}

export function deriveProviderModelsForDisplay(input: {
  readonly liveModels: ReadonlyArray<ServerProviderModel> | undefined;
  readonly customModels: ReadonlyArray<string>;
}): ReadonlyArray<ServerProviderModel> {
  const liveCustomModelsBySlug = new Map(
    Arr.filterMap(input.liveModels ?? [], (model) =>
      model.isCustom ? Result.succeed([model.slug, model] as const) : Result.failVoid,
    ),
  );

  const serverModels = input.liveModels?.filter((model) => !model.isCustom) ?? [];

  // A hand-added slug the live catalog also reports is one model, not two: a
  // discovery-capable driver (e.g. Custom API) reports both, and the catalog
  // row already carries the correct name and capabilities.
  const serverSlugs = new Set(serverModels.map((model) => model.slug));

  const customModels = input.customModels
    .filter((slug) => !serverSlugs.has(slug))
    .map(
      (slug) =>
        liveCustomModelsBySlug.get(slug) ?? {
          slug,
          name: slug,
          isCustom: true,
          capabilities: null,
        },
    );

  return [...serverModels, ...customModels];
}
