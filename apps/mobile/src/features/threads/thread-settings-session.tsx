import { driverSupportsDelegation } from "@akeru/shared/delegationProviders";
import type {
  EnvironmentId,
  ModelSelection,
  ProviderOptionDescriptor,
  ProviderOptionSelection,
  RuntimeMode,
  ThreadId,
} from "@akeru/contracts";
import { getProviderOptionDescriptors } from "@akeru/shared/model";
import * as Haptics from "expo-haptics";
import { createContext, use, useCallback, useMemo, useState, type ReactNode } from "react";
import type { ModelOption, ProviderGroup } from "../../lib/modelOptions";
import { applyProviderOptionSelection } from "../../lib/providerOptions";
import {
  pendingModelAfterPress,
  stageModelWithAppliedOptions,
} from "./thread-settings-sheet-state";

export type ThreadSettingsSubmenuPage =
  | { readonly kind: "descriptor"; readonly id: string }
  | { readonly kind: "runtime" }
  | { readonly kind: "memory" }
  | { readonly kind: "routines" };

export type ThreadSettingsSessionProps = {
  readonly providerGroups: ReadonlyArray<ProviderGroup>;
  readonly selectedModel: ModelSelection | null;
  readonly onSelectModel: (option: ModelOption) => void;
  readonly optionDescriptors: ReadonlyArray<ProviderOptionDescriptor>;
  readonly onUpdateOptionSelections: (selections: ReadonlyArray<ProviderOptionSelection>) => void;
  readonly runtimeMode: RuntimeMode;
  readonly onUpdateRuntimeMode: (mode: RuntimeMode) => void;
  readonly memoryThreadRef?: {
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId;
  };
  readonly routinesRef?: {
    readonly environmentId: EnvironmentId;
    readonly botId: string;
    readonly botName?: string;
  };
  /** Deletes the chat's bot. Resolves false when the server refuses. */
  /** Resolves to null on success, or the reason the delete failed. */
  readonly onDeleteBot?: () => Promise<string | null>;
};

export type ExistingThreadSettingsRouteSession = ThreadSettingsSessionProps & {
  readonly ownerId: string;
  readonly engineBotRef?: {
    readonly environmentId: EnvironmentId;
    readonly botId: string;
  };
};

type ExistingThreadSettingsRouteContextValue = {
  readonly session: ExistingThreadSettingsRouteSession | null;
  readonly present: (session: ExistingThreadSettingsRouteSession) => void;
  readonly clear: (ownerId: string) => void;
};

const ExistingThreadSettingsRouteContext =
  createContext<ExistingThreadSettingsRouteContextValue | null>(null);

/** Bridges the active thread's settings state into the root native sheet route. */
export function ExistingThreadSettingsRouteProvider(props: { readonly children: ReactNode }) {
  const [session, setSession] = useState<ExistingThreadSettingsRouteSession | null>(null);

  const present = useCallback((nextSession: ExistingThreadSettingsRouteSession) => {
    setSession(nextSession);
  }, []);

  const clear = useCallback((ownerId: string) => {
    setSession((current) => (current?.ownerId === ownerId ? null : current));
  }, []);

  const value = useMemo(() => ({ session, present, clear }), [clear, present, session]);

  return (
    <ExistingThreadSettingsRouteContext.Provider value={value}>
      {props.children}
    </ExistingThreadSettingsRouteContext.Provider>
  );
}

export function useExistingThreadSettingsRoutePresentation() {
  const value = use(ExistingThreadSettingsRouteContext);

  if (!value) {
    throw new Error(
      "useExistingThreadSettingsRoutePresentation must be used inside ExistingThreadSettingsRouteProvider.",
    );
  }

  return value;
}

export type ThreadSettingsSessionValue = {
  readonly providerGroups: ReadonlyArray<ProviderGroup>;
  readonly runtimeMode: RuntimeMode;
  readonly onUpdateRuntimeMode: (mode: RuntimeMode) => void;
  readonly displayedDescriptors: ReadonlyArray<ProviderOptionDescriptor>;
  readonly providerExpansionOverrides: ReadonlySet<string>;
  readonly hasLegacyModels: boolean;
  readonly pendingModel: ModelOption | null;
  readonly providerFilter: string | null;
  readonly searchQuery: string;
  readonly showLegacy: boolean;
  readonly applyOptionChange: (id: string, value: string | boolean) => void;
  readonly commitPendingModel: () => void;
  readonly isApplied: (option: ModelOption) => boolean;
  readonly isDisplayed: (option: ModelOption) => boolean;
  readonly pressModel: (option: ModelOption) => void;
  readonly setProviderFilter: (providerKey: string | null) => void;
  readonly setSearchQuery: (query: string) => void;
  readonly setShowLegacy: (showLegacy: boolean) => void;
  readonly toggleProvider: (providerKey: string) => void;
  readonly memoryThreadRef: ThreadSettingsSessionProps["memoryThreadRef"];
  readonly routinesRef: ThreadSettingsSessionProps["routinesRef"];
  readonly onDeleteBot: ThreadSettingsSessionProps["onDeleteBot"];
  /** False when the shown model's provider can neither hand off work nor receive it. */
  readonly canDelegate: boolean;
};

const ThreadSettingsSessionContext = createContext<ThreadSettingsSessionValue | null>(null);

/** Owns the staged model and option state for one picker presentation. */
export function ThreadSettingsSessionProvider(
  props: ThreadSettingsSessionProps & { readonly children: ReactNode },
) {
  const [showLegacyToggle, setShowLegacyToggle] = useState(false);
  const [providerFilter, setProviderFilter] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");

  const [providerExpansionOverrides, setProviderExpansionOverrides] = useState<ReadonlySet<string>>(
    () => new Set(),
  );

  const [pendingModel, setPendingModel] = useState<ModelOption | null>(null);

  const isApplied = useCallback(
    (option: ModelOption) =>
      option.selection.instanceId === props.selectedModel?.instanceId &&
      option.selection.model === props.selectedModel.model,
    [props.selectedModel],
  );

  // The list highlights the staged pick; Save turns it into the applied one.
  const isDisplayed = useCallback(
    (option: ModelOption) => (pendingModel ? option.key === pendingModel.key : isApplied(option)),
    [isApplied, pendingModel],
  );

  const displayedDriver = useMemo(
    () =>
      pendingModel?.providerDriver ??
      props.providerGroups.flatMap((group) => group.models).find((option) => isApplied(option))
        ?.providerDriver ??
      null,
    [isApplied, pendingModel, props.providerGroups],
  );

  const canDelegate = displayedDriver === null || driverSupportsDelegation(displayedDriver);

  // While a model is staged, the settings rows describe and edit the staged
  // model's options (kept on its pending selection); Save applies model and
  // options together. Otherwise they edit the applied selection directly.
  const displayedDescriptors = useMemo(
    () =>
      pendingModel
        ? pendingModel.capabilities
          ? getProviderOptionDescriptors({
              caps: pendingModel.capabilities,
              selections: pendingModel.selection.options,
            })
          : []
        : props.optionDescriptors,
    [pendingModel, props.optionDescriptors],
  );

  const hasLegacyModels = useMemo(
    () => props.providerGroups.some((group) => group.models.some((model) => model.isLegacy)),
    [props.providerGroups],
  );

  const commitPendingModel = useCallback(() => {
    if (pendingModel) {
      void Haptics.selectionAsync();
      props.onSelectModel(pendingModel);
    }
  }, [pendingModel, props.onSelectModel]);

  const applyOptionChange = useCallback(
    (id: string, value: string | boolean) => {
      const next = applyProviderOptionSelection(displayedDescriptors, { id, value });

      if (!next) {
        return;
      }

      if (pendingModel) {
        setPendingModel({
          ...pendingModel,
          selection: { ...pendingModel.selection, options: next },
        });
      } else {
        props.onUpdateOptionSelections(next);
      }
    },
    [displayedDescriptors, pendingModel, props.onUpdateOptionSelections],
  );

  const toggleProvider = useCallback((providerKey: string) => {
    setProviderExpansionOverrides((current) => {
      const next = new Set(current);

      if (!next.delete(providerKey)) {
        next.add(providerKey);
      }

      return next;
    });
  }, []);

  const pressModel = useCallback(
    (option: ModelOption) => {
      if (option.disabledReason) return;
      void Haptics.selectionAsync();
      setPendingModel((current) =>
        pendingModelAfterPress({
          current,
          pressed: stageModelWithAppliedOptions(option, props.selectedModel),
          pressedIsApplied: isApplied(option),
        }),
      );
    },
    [isApplied, props.selectedModel],
  );

  const value = useMemo<ThreadSettingsSessionValue>(
    () => ({
      providerGroups: props.providerGroups,
      runtimeMode: props.runtimeMode,
      onUpdateRuntimeMode: props.onUpdateRuntimeMode,
      displayedDescriptors,
      providerExpansionOverrides,
      hasLegacyModels,
      pendingModel,
      providerFilter,
      searchQuery,
      showLegacy: showLegacyToggle,
      applyOptionChange,
      commitPendingModel,
      isApplied,
      isDisplayed,
      pressModel,
      setProviderFilter,
      setSearchQuery,
      setShowLegacy: setShowLegacyToggle,
      toggleProvider,
      memoryThreadRef: props.memoryThreadRef,
      routinesRef: props.routinesRef,
      onDeleteBot: props.onDeleteBot,
      canDelegate,
    }),
    [
      applyOptionChange,
      canDelegate,
      commitPendingModel,
      displayedDescriptors,
      providerExpansionOverrides,
      hasLegacyModels,
      isApplied,
      isDisplayed,
      pendingModel,
      pressModel,
      providerFilter,
      props.onUpdateRuntimeMode,
      props.providerGroups,
      props.runtimeMode,
      props.memoryThreadRef,
      props.routinesRef,
      props.onDeleteBot,
      searchQuery,
      showLegacyToggle,
      toggleProvider,
    ],
  );

  return (
    <ThreadSettingsSessionContext.Provider value={value}>
      {props.children}
    </ThreadSettingsSessionContext.Provider>
  );
}

export function useThreadSettingsSession() {
  const value = use(ThreadSettingsSessionContext);

  if (!value) {
    throw new Error("useThreadSettingsSession must be used inside ThreadSettingsSessionProvider.");
  }

  return value;
}
