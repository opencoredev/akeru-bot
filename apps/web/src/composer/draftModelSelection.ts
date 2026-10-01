import * as Option from "effect/Option";
import { storedField } from "../lib/persistedSchema";
import * as Predicate from "effect/Predicate";
import {
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  defaultInstanceIdForDriver,
  ModelSelection,
  ProviderInstanceId,
  ProviderDriverKind,
  ProviderOptionSelection,
  type ServerProvider,
} from "@akeru/contracts";
import * as Schema from "effect/Schema";
import { DeepMutable } from "effect/Types";
import { createModelSelection, normalizeModelSlug } from "@akeru/shared/model";
import { resolveAppModelSelection, resolveAppModelSelectionForInstance } from "../modelSelection";
import { getDefaultServerModel } from "../providerModels";
import { UnifiedSettings } from "@akeru/contracts/settings";
import {
  type ProviderOptionSelectionsByProvider,
  type LegacyCodexFields,
} from "./draftPersistenceSchemas";
import { type ComposerThreadDraftState, type EffectiveComposerModelState } from "./draftTypes";

const isProviderDriverKind = Schema.is(ProviderDriverKind);

function providerSelectionsFromModelSelection(
  modelSelection: ModelSelection | null | undefined,
): ProviderOptionSelectionsByProvider | null {
  if (!modelSelection) {
    return null;
  }

  const options = modelSelection.options;

  if (!options || options.length === 0) {
    return null;
  }

  return { [modelSelection.instanceId]: options };
}

function modelSelectionByProviderToOptions(
  map: Partial<Record<string, ModelSelection>> | null | undefined,
): ProviderOptionSelectionsByProvider | null {
  if (!map) return null;
  const result: ProviderOptionSelectionsByProvider = {};

  for (const [provider, selection] of Object.entries(map)) {
    if (selection?.options && selection.options.length > 0) {
      result[provider] = selection.options;
    }
  }

  return Object.keys(result).length > 0 ? result : null;
}

function cloneModelSelection(selection: ModelSelection): DeepMutable<ModelSelection> {
  const { options, ...rest } = selection;

  return { ...rest, ...(options ? { options: options.map((option) => ({ ...option })) } : {}) };
}

export function compactModelSelectionByProvider(
  selections: Partial<Record<ProviderInstanceId, ModelSelection>>,
): DeepMutable<Record<ProviderInstanceId, ModelSelection>> {
  const result: DeepMutable<Record<ProviderInstanceId, ModelSelection>> = {};

  for (const [provider, selection] of Object.entries(selections)) {
    if (selection !== undefined)
      result[ProviderInstanceId.make(provider)] = cloneModelSelection(selection);
  }

  return result;
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- This schema guard is the boundary for legacy driver values from storage.
export function normalizeProviderDriverKind(value: unknown): ProviderDriverKind | null {
  return isProviderDriverKind(value) ? value : null;
}

const isProviderInstanceId = Schema.is(ProviderInstanceId);

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- This schema guard accepts untrusted instance identifiers at the storage boundary.
export function normalizeProviderInstanceId(value: unknown): ProviderInstanceId | null {
  return isProviderInstanceId(value) ? value : null;
}

function isStoredRecord(value: Schema.Json | undefined): value is Schema.JsonObject {
  return Predicate.isObject(value);
}

/**
 * Coerce an unknown value into a `ReadonlyArray<ProviderOptionSelection>`.
 * Accepts either:
 *   - the v3 representation: an array of `{ id, value }` entries
 *   - the legacy v2 representation: a record of `{ id: string | boolean }`
 *
 * Validation is intentionally permissive: descriptors are the source of truth
 * for which option ids are meaningful for a given provider/model. Anything
 * outside the descriptor list is harmless trailing data and will simply be
 * ignored downstream.
 */
function coerceProviderOptionSelections(
  value: Schema.Json | undefined,
): ReadonlyArray<ProviderOptionSelection> | undefined {
  if (Array.isArray(value)) {
    const out: ProviderOptionSelection[] = [];

    for (const entry of value) {
      if (!isStoredRecord(entry)) continue;
      const record = entry;
      const id = record.id;
      const optionValue = record.value;

      if (!Predicate.isString(id) || id.length === 0) continue;

      if (Predicate.isString(optionValue) || Predicate.isBoolean(optionValue)) {
        out.push({ id, value: optionValue });
      }
    }

    return out.length > 0 ? out : undefined;
  }

  if (isStoredRecord(value)) {
    const record = value;
    const out: ProviderOptionSelection[] = [];

    for (const [id, raw] of Object.entries(record)) {
      if (Predicate.isString(raw) || Predicate.isBoolean(raw)) {
        out.push({ id, value: raw });
      }
    }

    return out.length > 0 ? out : undefined;
  }

  return undefined;
}

/**
 * Normalize a per-provider options bag from either the v3 or legacy v2 shape.
 *
 * `provider` and `legacy` parameters are migration-only inputs used to
 * recover legacy codex fields (effort/codexFastMode/serviceTier) that lived
 * directly on the draft instead of inside `modelOptions.codex`.
 */
const StoredProviderOptions = Schema.Struct({
  codex: storedField(Schema.NullOr(Schema.Json), null),
  claudeAgent: storedField(Schema.NullOr(Schema.Json), null),
  opencode: storedField(Schema.NullOr(Schema.Json), null),
});

const decodeStoredProviderOptions = Schema.decodeUnknownOption(StoredProviderOptions);

export function normalizeProviderModelOptions(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- The decoder validates the legacy options object before migration reads its fields.
  value: unknown,
  provider?: ProviderDriverKind | null,
  legacy?: LegacyCodexFields,
): ProviderOptionSelectionsByProvider | null {
  const decoded = decodeStoredProviderOptions(value);
  const candidate = Option.isSome(decoded) ? decoded.value : null;

  const result: ProviderOptionSelectionsByProvider = {};

  for (const providerKey of ["codex", "claudeAgent", "opencode"] as const) {
    const selections = coerceProviderOptionSelections(candidate?.[providerKey]);

    if (selections) {
      result[providerKey] = selections;
    }
  }

  // Recover legacy codex fields that lived outside modelOptions.
  if (provider === "codex" && legacy) {
    const codexExtras: ProviderOptionSelection[] = [];

    if (Predicate.isString(legacy.effort) && legacy.effort.length > 0) {
      codexExtras.push({ id: "reasoningEffort", value: legacy.effort });
    }

    const fastMode =
      legacy.codexFastMode === true ||
      (Predicate.isString(legacy.serviceTier) && legacy.serviceTier === "fast");

    if (fastMode) {
      codexExtras.push({ id: "fastMode", value: true });
    }

    if (codexExtras.length > 0) {
      const existing = result.codex ?? [];
      const existingIds = new Set(existing.map((entry) => entry.id));
      const merged = [...existing];

      for (const extra of codexExtras) {
        if (!existingIds.has(extra.id)) merged.push(extra);
      }

      result.codex = merged;
    }
  }

  return Object.keys(result).length > 0 ? result : null;
}

// Returns a model selection whose `instanceId` is a valid
// `ProviderInstanceId` slug. Legacy `provider` fields are promoted verbatim
// because default instance ids used the same slug as the driver kind.
//
// Selections whose instance id doesn't match the slug pattern collapse to
// `null` — caller is responsible for deciding whether that's a dropped
// write or a routed error.
const StoredModelSelection = Schema.Struct({
  instanceId: storedField(Schema.NullOr(Schema.Json), null),
  provider: storedField(Schema.NullOr(Schema.Json), null),
  model: storedField(Schema.NullOr(Schema.Json), null),
  options: storedField(Schema.NullOr(Schema.Json), null),
});

const decodeStoredModelSelection = Schema.decodeUnknownOption(StoredModelSelection);

export function normalizeModelSelection(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- The decoder validates persisted model fields before the legacy migration consumes them.
  value: unknown,
  legacy?: {
    provider?: unknown;
    model?: unknown;
    modelOptions?: unknown;
    legacyCodex?: LegacyCodexFields;
  },
): NormalizedModelSelection | null {
  const decoded = decodeStoredModelSelection(value);
  const candidate = Option.isSome(decoded) ? decoded.value : null;

  // Post-migration ModelSelection carries `instanceId`; pre-migration (v2
  // storage, legacy wire shapes) carries `provider`. Accept either so both
  // normalized stores and legacy drafts round-trip through this helper.
  const instanceId = normalizeProviderInstanceId(
    candidate?.instanceId ?? candidate?.provider ?? legacy?.provider,
  );

  if (instanceId === null) {
    return null;
  }

  const rawModel = candidate?.model ?? legacy?.model;

  if (!Predicate.isString(rawModel)) {
    return null;
  }

  // Slug normalization can use provider-kind-specific rules when a legacy
  // driver key is present. Instance-only selections are not reverse-inferred
  // into a driver kind here; they get generic default normalization.
  const driverKindHint =
    normalizeProviderDriverKind(candidate?.provider ?? legacy?.provider) ??
    ProviderDriverKind.make("codex");

  const model = normalizeModelSlug(rawModel, driverKindHint);

  if (!model) {
    return null;
  }

  if (Array.isArray(candidate?.options)) {
    const selections = coerceProviderOptionSelections(candidate.options);

    return createModelSelection(instanceId, model, selections);
  }

  // Per-kind options were a pre-migration concern; only recover them for a
  // built-in-kind instance. Custom instances don't have a legacy options
  // store to thread through here.
  const kindForLegacyOptions = normalizeProviderDriverKind(instanceId);

  const modelOptions = kindForLegacyOptions
    ? normalizeProviderModelOptions(
        candidate?.options ? { [kindForLegacyOptions]: candidate.options } : legacy?.modelOptions,
        kindForLegacyOptions,
        kindForLegacyOptions === "codex" ? legacy?.legacyCodex : undefined,
      )
    : null;

  const options = kindForLegacyOptions ? modelOptions?.[kindForLegacyOptions] : undefined;

  return createModelSelection(instanceId, model, options);
}

type NormalizedModelSelection = Omit<ModelSelection, "instanceId"> & {
  readonly instanceId: ProviderInstanceId;
};

// ── Legacy sync helpers (used only during migration from v2 storage) ──
//
// These operate against the legacy kind-keyed `modelOptions` map. The
// normalized selection now carries an open `ProviderInstanceId`; legacy
// migration only recovers options for keys that existed before custom
// provider instances.

export function legacySyncModelSelectionOptions(
  modelSelection: NormalizedModelSelection | null,
  modelOptions: ProviderOptionSelectionsByProvider | null | undefined,
): NormalizedModelSelection | null {
  if (modelSelection === null) {
    return null;
  }

  const kind = normalizeProviderDriverKind(modelSelection.instanceId);
  const options = kind ? modelOptions?.[kind] : undefined;

  return createModelSelection(modelSelection.instanceId, modelSelection.model, options);
}

export function legacyMergeModelSelectionIntoProviderModelOptions(
  modelSelection: NormalizedModelSelection | null,
  currentModelOptions: ProviderOptionSelectionsByProvider | null | undefined,
): ProviderOptionSelectionsByProvider | null {
  if (!modelSelection?.options || modelSelection.options.length === 0) {
    return normalizeProviderModelOptions(currentModelOptions);
  }

  const kind = normalizeProviderDriverKind(modelSelection.instanceId);

  if (!kind) {
    return normalizeProviderModelOptions(currentModelOptions);
  }

  return legacyReplaceProviderModelOptions(
    normalizeProviderModelOptions(currentModelOptions),
    kind,
    modelSelection.options,
  );
}

function legacyReplaceProviderModelOptions(
  currentModelOptions: ProviderOptionSelectionsByProvider | null | undefined,
  provider: ProviderDriverKind,
  nextProviderOptions: ReadonlyArray<ProviderOptionSelection> | null | undefined,
): ProviderOptionSelectionsByProvider | null {
  const { [provider]: _discardedProviderModelOptions, ...otherProviderModelOptions } =
    currentModelOptions ?? {};

  const merged: ProviderOptionSelectionsByProvider = { ...otherProviderModelOptions };

  if (nextProviderOptions && nextProviderOptions.length > 0) {
    merged[provider] = nextProviderOptions;
  }

  return Object.keys(merged).length > 0 ? merged : null;
}

// ── New helpers for the consolidated representation ────────────────────

export function legacyToModelSelectionByProvider(
  modelSelection: NormalizedModelSelection | null,
  modelOptions: ProviderOptionSelectionsByProvider | null | undefined,
): Partial<Record<ProviderInstanceId, ModelSelection>> {
  const result: Partial<Record<ProviderInstanceId, ModelSelection>> = {};

  if (modelOptions) {
    for (const provider of ["codex", "claudeAgent", "opencode"] as const) {
      const options = modelOptions[provider];

      if (options && options.length > 0) {
        const driverKind = ProviderDriverKind.make(provider);
        const instanceKey = defaultInstanceIdForDriver(driverKind);
        result[instanceKey] = createModelSelection(
          instanceKey,
          modelSelection?.instanceId === instanceKey
            ? modelSelection.model
            : (DEFAULT_MODEL_BY_PROVIDER[driverKind] ?? DEFAULT_MODEL),
          options,
        );
      }
    }
  }

  if (modelSelection) {
    result[modelSelection.instanceId] = modelSelection;
  }

  return result;
}

export function deriveEffectiveComposerModelState(input: {
  draft:
    | Pick<ComposerThreadDraftState, "modelSelectionByProvider" | "activeProvider">
    | null
    | undefined;
  providers: ReadonlyArray<ServerProvider>;
  selectedProvider: ProviderDriverKind;
  /**
   * Optional routing key of the instance whose selection should override
   * the driver-level lookup. When present, the draft is queried by
   * `modelSelectionByProvider[selectedInstanceId]` so a custom Codex
   * instance (e.g. `codex_personal`) reads its own saved model instead of
   * collapsing to the default Codex bucket.
   */
  selectedInstanceId?: ProviderInstanceId | null | undefined;
  threadModelSelection: ModelSelection | null | undefined;
  projectModelSelection: ModelSelection | null | undefined;
  settings: UnifiedSettings;
}): EffectiveComposerModelState {
  const baseModelCandidate =
    input.threadModelSelection?.model ?? input.projectModelSelection?.model ?? null;

  const baseModel =
    (input.selectedInstanceId
      ? resolveAppModelSelectionForInstance(
          input.selectedInstanceId,
          input.settings,
          input.providers,
          baseModelCandidate,
        )
      : null) ??
    resolveAppModelSelection(
      input.selectedProvider,
      input.settings,
      input.providers,
      baseModelCandidate,
    ) ??
    normalizeModelSlug(baseModelCandidate, input.selectedProvider) ??
    getDefaultServerModel(input.providers, input.selectedProvider);

  // Look up the instance's saved selection first; fall back to the
  // driver-kind bucket so legacy kind-keyed drafts still resolve. Every
  // `ProviderDriverKind` literal is a valid `ProviderInstanceId` slug, so the
  // cast to the branded type is safe.
  const instanceSelection = input.selectedInstanceId
    ? input.draft?.modelSelectionByProvider?.[input.selectedInstanceId]
    : undefined;

  const legacySelection =
    input.draft?.modelSelectionByProvider?.[ProviderInstanceId.make(input.selectedProvider)];

  const activeSelection = instanceSelection ?? legacySelection;

  const activeSelectionInstanceId = instanceSelection
    ? (input.selectedInstanceId ?? ProviderInstanceId.make(input.selectedProvider))
    : ProviderInstanceId.make(input.selectedProvider);

  const selectedModel = activeSelection?.model
    ? (resolveAppModelSelectionForInstance(
        activeSelectionInstanceId,
        input.settings,
        input.providers,
        activeSelection.model,
      ) ??
      resolveAppModelSelection(
        input.selectedProvider,
        input.settings,
        input.providers,
        activeSelection.model,
      ))
    : baseModel;

  const modelOptions =
    modelSelectionByProviderToOptions(input.draft?.modelSelectionByProvider) ??
    providerSelectionsFromModelSelection(input.threadModelSelection) ??
    providerSelectionsFromModelSelection(input.projectModelSelection) ??
    null;

  return {
    selectedModel,
    modelOptions,
  };
}
