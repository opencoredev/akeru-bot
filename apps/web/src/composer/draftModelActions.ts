import type { StoreApi } from "zustand";
import {
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  defaultInstanceIdForDriver,
  ModelSelection,
  ProviderInstanceId,
  ProviderDriverKind,
} from "@akeru/contracts";
import * as Equal from "effect/Equal";
import { createModelSelection, normalizeModelSlug } from "@akeru/shared/model";
import {
  type ComposerDraftStoreState,
  createEmptyThreadDraft,
  type ComposerThreadDraftState,
  isRuntimeMode,
} from "./draftTypes";
import { normalizeModelSelection, normalizeProviderDriverKind } from "./draftModelSelection";
import { resolveComposerDraftKey } from "./draftIdentity";
import { shouldRemoveDraft } from "./draftContent";

export function createDraftModelActions(
  set: StoreApi<ComposerDraftStoreState>["setState"],
  get: StoreApi<ComposerDraftStoreState>["getState"],
): Pick<
  ComposerDraftStoreState,
  | "setStickyModelSelection"
  | "applyStickyState"
  | "setModelSelection"
  | "setModelOptions"
  | "setProviderModelOptions"
  | "setRuntimeMode"
> {
  return {
    setStickyModelSelection: (modelSelection) => {
      const normalized = normalizeModelSelection(modelSelection);
      set((state) => {
        if (!normalized) {
          return state;
        }

        const nextMap: Partial<Record<ProviderInstanceId, ModelSelection>> = {
          ...state.stickyModelSelectionByProvider,
          [normalized.instanceId]: normalized,
        };

        if (Equal.equals(state.stickyModelSelectionByProvider, nextMap)) {
          return state.stickyActiveProvider === normalized.instanceId
            ? state
            : { stickyActiveProvider: normalized.instanceId };
        }

        return {
          stickyModelSelectionByProvider: nextMap,
          stickyActiveProvider: normalized.instanceId,
        };
      });
    },

    applyStickyState: (threadRef) => {
      const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";

      if (threadKey.length === 0) {
        return;
      }

      set((state) => {
        const stickyMap = state.stickyModelSelectionByProvider;
        const stickyActiveProvider = state.stickyActiveProvider;

        if (Object.keys(stickyMap).length === 0 && stickyActiveProvider === null) {
          return state;
        }

        const existing = state.draftsByThreadKey[threadKey];
        const base = existing ?? createEmptyThreadDraft();
        const nextMap = { ...base.modelSelectionByProvider };

        for (const [provider, selection] of Object.entries(stickyMap)) {
          if (selection) {
            // Iteration key comes from the instance-keyed sticky map,
            // so coerce the string back to `ProviderInstanceId` for
            // the typed lookup.
            const instanceKey = ProviderInstanceId.make(provider);
            const current = nextMap[instanceKey];
            nextMap[instanceKey] = {
              ...selection,
              model: current?.model ?? selection.model,
            };
          }
        }

        if (
          Equal.equals(base.modelSelectionByProvider, nextMap) &&
          base.activeProvider === stickyActiveProvider
        ) {
          return state;
        }

        const nextDraft: ComposerThreadDraftState = {
          ...base,
          modelSelectionByProvider: nextMap,
          activeProvider: stickyActiveProvider,
        };

        const nextDraftsByThreadKey = { ...state.draftsByThreadKey };

        if (shouldRemoveDraft(nextDraft)) {
          delete nextDraftsByThreadKey[threadKey];
        } else {
          nextDraftsByThreadKey[threadKey] = nextDraft;
        }

        return { draftsByThreadKey: nextDraftsByThreadKey };
      });
    },

    setModelSelection: (threadRef, modelSelection, opts) => {
      const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";

      if (threadKey.length === 0) {
        return;
      }

      const normalized = normalizeModelSelection(modelSelection);
      set((state) => {
        const existing = state.draftsByThreadKey[threadKey];

        if (!existing && normalized === null) {
          return state;
        }

        const base = existing ?? createEmptyThreadDraft();
        const nextMap = { ...base.modelSelectionByProvider };

        if (normalized) {
          const current = nextMap[normalized.instanceId];

          if (normalized.options !== undefined || opts?.replaceOptions) {
            // Explicit options provided (or the caller passed a complete
            // snapshot whose absent options mean "no options") → use the
            // selection as-is.
            nextMap[normalized.instanceId] = normalized;
          } else {
            // No options in selection → preserve existing options, update provider+model
            nextMap[normalized.instanceId] = createModelSelection(
              normalized.instanceId,
              normalized.model,
              current?.options,
            );
          }
        }

        const nextActiveProvider = normalized?.instanceId ?? base.activeProvider;

        if (
          Equal.equals(base.modelSelectionByProvider, nextMap) &&
          base.activeProvider === nextActiveProvider
        ) {
          return state;
        }

        const nextDraft: ComposerThreadDraftState = {
          ...base,
          modelSelectionByProvider: nextMap,
          activeProvider: nextActiveProvider,
        };

        const nextDraftsByThreadKey = { ...state.draftsByThreadKey };

        if (shouldRemoveDraft(nextDraft)) {
          delete nextDraftsByThreadKey[threadKey];
        } else {
          nextDraftsByThreadKey[threadKey] = nextDraft;
        }

        return { draftsByThreadKey: nextDraftsByThreadKey };
      });
    },

    setModelOptions: (threadRef, modelOptions) => {
      const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";

      if (threadKey.length === 0) {
        return;
      }

      set((state) => {
        const existing = state.draftsByThreadKey[threadKey];

        if (!existing && (!modelOptions || Object.keys(modelOptions).length === 0)) {
          return state;
        }

        const base = existing ?? createEmptyThreadDraft();
        const nextMap = { ...base.modelSelectionByProvider };

        for (const provider of ["codex", "claudeAgent", "opencode"] as const) {
          if (!modelOptions || !(provider in modelOptions)) continue;
          const opts = modelOptions[provider];
          const driverKind = ProviderDriverKind.make(provider);
          const instanceKey = defaultInstanceIdForDriver(driverKind);
          const current = nextMap[instanceKey];

          if (opts && opts.length > 0) {
            nextMap[instanceKey] = createModelSelection(
              instanceKey,
              current?.model ?? DEFAULT_MODEL_BY_PROVIDER[driverKind] ?? DEFAULT_MODEL,
              opts,
            );
          } else if (current?.options) {
            const { options: _, ...rest } = current;
            nextMap[instanceKey] = rest;
          }
        }

        if (Equal.equals(base.modelSelectionByProvider, nextMap)) {
          return state;
        }

        const nextDraft: ComposerThreadDraftState = {
          ...base,
          modelSelectionByProvider: nextMap,
        };

        const nextDraftsByThreadKey = { ...state.draftsByThreadKey };

        if (shouldRemoveDraft(nextDraft)) {
          delete nextDraftsByThreadKey[threadKey];
        } else {
          nextDraftsByThreadKey[threadKey] = nextDraft;
        }

        return { draftsByThreadKey: nextDraftsByThreadKey };
      });
    },

    setProviderModelOptions: (threadRef, provider, nextProviderOptions, options) => {
      const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";

      if (threadKey.length === 0) {
        return;
      }

      const normalizedProvider = normalizeProviderDriverKind(provider);

      if (normalizedProvider === null) {
        return;
      }

      const instanceKey = options?.instanceId ?? defaultInstanceIdForDriver(normalizedProvider);

      const fallbackModel =
        normalizeModelSlug(options?.model, normalizedProvider) ??
        DEFAULT_MODEL_BY_PROVIDER[normalizedProvider] ??
        DEFAULT_MODEL;

      const providerOpts =
        nextProviderOptions && nextProviderOptions.length > 0 ? nextProviderOptions : undefined;

      set((state) => {
        const existing = state.draftsByThreadKey[threadKey];
        const base = existing ?? createEmptyThreadDraft();

        // Update the map entry for this provider
        const nextMap = { ...base.modelSelectionByProvider };
        const currentForProvider = nextMap[instanceKey];

        if (providerOpts) {
          nextMap[instanceKey] = createModelSelection(
            instanceKey,
            currentForProvider?.model ?? fallbackModel,
            providerOpts,
          );
        } else if (currentForProvider && (currentForProvider.options?.length ?? 0) > 0) {
          const { options: _, ...rest } = currentForProvider;
          nextMap[instanceKey] = rest;
        }

        // Handle sticky persistence
        let nextStickyMap = state.stickyModelSelectionByProvider;
        let nextStickyActiveProvider = state.stickyActiveProvider;

        if (options?.persistSticky === true) {
          nextStickyMap = { ...state.stickyModelSelectionByProvider };

          const stickyBase =
            nextStickyMap[instanceKey] ??
            base.modelSelectionByProvider[instanceKey] ??
            createModelSelection(instanceKey, fallbackModel);

          if (providerOpts) {
            nextStickyMap[instanceKey] = createModelSelection(
              instanceKey,
              stickyBase.model,
              providerOpts,
            );
          } else if ((stickyBase.options?.length ?? 0) > 0) {
            const { options: _, ...rest } = stickyBase;
            nextStickyMap[instanceKey] = rest;
          }

          nextStickyActiveProvider = options.instanceId
            ? instanceKey
            : (base.activeProvider ?? instanceKey);
        }

        if (
          Equal.equals(base.modelSelectionByProvider, nextMap) &&
          Equal.equals(state.stickyModelSelectionByProvider, nextStickyMap) &&
          state.stickyActiveProvider === nextStickyActiveProvider
        ) {
          return state;
        }

        const nextDraft: ComposerThreadDraftState = {
          ...base,
          ...(options?.instanceId ? { activeProvider: instanceKey } : {}),
          modelSelectionByProvider: nextMap,
        };

        const nextDraftsByThreadKey = { ...state.draftsByThreadKey };

        if (shouldRemoveDraft(nextDraft)) {
          delete nextDraftsByThreadKey[threadKey];
        } else {
          nextDraftsByThreadKey[threadKey] = nextDraft;
        }

        return {
          draftsByThreadKey: nextDraftsByThreadKey,
          ...(options?.persistSticky === true
            ? {
                stickyModelSelectionByProvider: nextStickyMap,
                stickyActiveProvider: nextStickyActiveProvider,
              }
            : {}),
        };
      });
    },

    setRuntimeMode: (threadRef, runtimeMode) => {
      const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";

      if (threadKey.length === 0) {
        return;
      }

      const nextRuntimeMode = isRuntimeMode(runtimeMode) ? runtimeMode : null;
      set((state) => {
        const existing = state.draftsByThreadKey[threadKey];

        if (!existing && nextRuntimeMode === null) {
          return state;
        }

        const base = existing ?? createEmptyThreadDraft();

        if (base.runtimeMode === nextRuntimeMode) {
          return state;
        }

        const nextDraft: ComposerThreadDraftState = {
          ...base,
          runtimeMode: nextRuntimeMode,
        };

        const nextDraftsByThreadKey = { ...state.draftsByThreadKey };

        if (shouldRemoveDraft(nextDraft)) {
          delete nextDraftsByThreadKey[threadKey];
        } else {
          nextDraftsByThreadKey[threadKey] = nextDraft;
        }

        return { draftsByThreadKey: nextDraftsByThreadKey };
      });
    },
  };
}
