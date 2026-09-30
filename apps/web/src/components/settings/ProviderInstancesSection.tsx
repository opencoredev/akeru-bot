import { useAtomValue } from "@effect/atom-react";
import { safeErrorLogAttributes } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  defaultInstanceIdForDriver,
  type EnvironmentId,
  PROVIDER_DISPLAY_NAMES,
  type ProviderDriverKind,
  type ProviderInstanceConfig,
  type ProviderInstanceId,
  resolveProviderInstanceEnabled,
  type ServerProvider,
} from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS, type UnifiedSettings } from "@t3tools/contracts/settings";
import * as Arr from "effect/Array";
import * as Equal from "effect/Equal";
import * as Result from "effect/Result";
import { LoaderIcon, PlusIcon, RefreshCwIcon } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";

import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { resolveAppModelSelectionState } from "../../modelSelection";
import { useEnvironment } from "../../state/environments";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  canOneClickUpdateProviderCandidate,
  collectProviderUpdateCandidates,
  hasOneClickUpdateProviderCandidate,
  isProviderUpdateActive,
  type ProviderUpdateCandidate,
} from "../providerUpdates.logic";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { AddProviderInstanceDialog } from "./AddProviderInstanceDialog";
import { ProviderInstanceCard } from "./ProviderInstanceCard";
import { ProviderAccountSection } from "./ProvidersPanel";
import type { SubscriptionProviderDefinition } from "./subscriptionProviders";
import { getDriverOption } from "./providerDriverMeta";
import { SettingsMessageRow } from "./settingsDetailLayout";
import { buildProviderInstanceUpdatePatch } from "./SettingsPanels.logic";
import { SettingResetButton, SettingsSection } from "./settingsLayout";
import { useI18n } from "../../i18n";

function withoutProviderInstanceKey<V>(
  record: Readonly<Record<ProviderInstanceId, V>> | undefined,
  key: ProviderInstanceId,
): Record<ProviderInstanceId, V> {
  const next = { ...record } as Record<ProviderInstanceId, V>;
  delete next[key];
  return next;
}

interface InstanceRow {
  readonly instanceId: ProviderInstanceId;
  readonly instance: ProviderInstanceConfig;
  readonly driver: ProviderDriverKind;
  readonly isDefault: boolean;
  readonly isDirty: boolean;
}

type EnvironmentSettings = UnifiedSettings;
type LegacyProviderSettings =
  EnvironmentSettings["providers"][keyof EnvironmentSettings["providers"]];

/**
 * The instances that run a set of drivers: the built-in default slot first
 * (synthesized from the legacy per-driver settings until the user edits it),
 * then any custom instances in settings order.
 */
function instanceRowsForDrivers(
  settings: EnvironmentSettings,
  drivers: ReadonlyArray<ProviderDriverKind>,
): InstanceRow[] {
  const legacyProviders = settings.providers as Record<string, LegacyProviderSettings | undefined>;
  const defaultLegacyProviders = DEFAULT_UNIFIED_SETTINGS.providers as Record<
    string,
    LegacyProviderSettings | undefined
  >;
  const rows: InstanceRow[] = [];
  for (const driver of drivers) {
    const defaultInstanceId = defaultInstanceIdForDriver(driver);
    const explicitInstance = settings.providerInstances?.[defaultInstanceId];
    // A remote environment may run a server whose settings predate this
    // driver, so the legacy blob can be missing too.
    const legacyConfig = legacyProviders[driver];
    let defaultInstance: ProviderInstanceConfig | undefined = explicitInstance;
    if (defaultInstance === undefined && legacyConfig !== undefined) {
      // The envelope owns `enabled`. Leaving the legacy flag inside the
      // config would let it override the Switch forever.
      const { enabled, ...config } = legacyConfig;
      defaultInstance = { driver, enabled, config };
    }
    if (defaultInstance !== undefined) {
      rows.push({
        instanceId: defaultInstanceId,
        instance: defaultInstance,
        driver,
        isDefault: true,
        isDirty:
          explicitInstance !== undefined ||
          !Equal.equals(legacyConfig, defaultLegacyProviders[driver]),
      });
    }
    for (const [rawId, instance] of Object.entries(settings.providerInstances ?? {})) {
      const id = rawId as ProviderInstanceId;
      if (instance.driver !== driver || id === defaultInstanceId) continue;
      rows.push({ instanceId: id, instance, driver, isDefault: false, isDirty: false });
    }
  }
  return rows;
}

/**
 * Runtime configuration for one provider on its subpage: each instance with
 * its enable switch, display name, accent color, environment variables,
 * driver settings, and models. Details open on demand.
 */
export function ProviderInstancesSection({
  environmentId,
  drivers,
  providerLabel,
  account,
}: {
  readonly environmentId: EnvironmentId;
  readonly drivers: ReadonlyArray<ProviderDriverKind>;
  readonly providerLabel: string;
  readonly account?: SubscriptionProviderDefinition;
}) {
  const { t } = useI18n();
  const environment = useEnvironment(environmentId);
  const settings = useEnvironmentSettings(environmentId);
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const serverProviders =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const refreshServerProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const updateProvider = useAtomCommand(serverEnvironment.updateProvider, {
    reportFailure: false,
  });
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
  const [updatingDrivers, setUpdatingDrivers] = useState<ReadonlySet<ProviderDriverKind>>(
    () => new Set(),
  );
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const refreshingRef = useRef(false);
  const updatingDriversRef = useRef<Set<ProviderDriverKind>>(new Set());

  const rows = instanceRowsForDrivers(settings, drivers);
  const updateCandidateByInstanceId = useMemo(
    () =>
      new Map(
        collectProviderUpdateCandidates(serverProviders).map((candidate) => [
          candidate.instanceId,
          candidate,
        ]),
      ),
    [serverProviders],
  );
  const textGenInstanceId = resolveAppModelSelectionState(settings, serverProviders).instanceId;

  const refreshProviders = useCallback(() => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    setIsRefreshing(true);
    void (async () => {
      const result = await refreshServerProviders({ environmentId, input: {} });
      refreshingRef.current = false;
      setIsRefreshing(false);
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        console.warn("Failed to refresh providers", {
          operation: "refresh-providers",
          environmentId,
          ...safeErrorLogAttributes(squashAtomCommandFailure(result)),
        });
      }
    })();
  }, [environmentId, refreshServerProviders]);

  const runProviderUpdate = useCallback(
    async (candidate: ProviderUpdateCandidate) => {
      // A ref guards re-entry because a state updater may run after return.
      if (updatingDriversRef.current.has(candidate.driver)) return;
      updatingDriversRef.current.add(candidate.driver);
      setUpdatingDrivers((previous) => new Set(previous).add(candidate.driver));
      const result = await updateProvider({
        environmentId,
        input: { provider: candidate.driver, instanceId: candidate.instanceId },
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: t("Could not update {provider}", {
              provider: PROVIDER_DISPLAY_NAMES[candidate.driver] ?? candidate.driver,
            }),
            description:
              error instanceof Error
                ? error.message
                : t("The provider update command could not be started."),
          }),
        );
      }
      updatingDriversRef.current.delete(candidate.driver);
      setUpdatingDrivers((previous) => {
        if (!previous.has(candidate.driver)) return previous;
        const next = new Set(previous);
        next.delete(candidate.driver);
        return next;
      });
    },
    [environmentId, t, updateProvider],
  );

  const updateInstance = (row: InstanceRow, next: ProviderInstanceConfig) => {
    // Disabling the instance that writes titles and commit messages falls
    // back to the default text generation model.
    const clearsTextGeneration =
      next.enabled === false &&
      resolveProviderInstanceEnabled(row.instance) &&
      textGenInstanceId === row.instanceId;
    updateSettings(
      buildProviderInstanceUpdatePatch({
        settings,
        instanceId: row.instanceId,
        instance: next,
        driver: row.driver,
        isDefault: row.isDefault,
        textGenerationModelSelection: clearsTextGeneration
          ? DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection
          : undefined,
      }),
    );
  };

  const deleteInstance = (id: ProviderInstanceId) => {
    updateSettings({
      providerInstances: withoutProviderInstanceKey(settings.providerInstances, id),
    });
  };

  const resetDefaultInstance = (driver: ProviderDriverKind) => {
    const defaultLegacy = (
      DEFAULT_UNIFIED_SETTINGS.providers as Record<string, LegacyProviderSettings | undefined>
    )[driver];
    if (defaultLegacy === undefined) return;
    updateSettings({
      providers: { ...settings.providers, [driver]: defaultLegacy } as typeof settings.providers,
      providerInstances: withoutProviderInstanceKey(
        settings.providerInstances,
        defaultInstanceIdForDriver(driver),
      ),
    });
  };

  const updateModelPreferences = (
    instanceId: ProviderInstanceId,
    next: {
      readonly hiddenModels: ReadonlyArray<string>;
      readonly modelOrder: ReadonlyArray<string>;
    },
  ) => {
    const hiddenModels = [...new Set(next.hiddenModels.filter((slug) => slug.trim().length > 0))];
    const modelOrder = [...new Set(next.modelOrder.filter((slug) => slug.trim().length > 0))];
    const rest = withoutProviderInstanceKey(settings.providerModelPreferences, instanceId);
    updateSettings({
      providerModelPreferences:
        hiddenModels.length === 0 && modelOrder.length === 0
          ? rest
          : { ...rest, [instanceId]: { hiddenModels, modelOrder } },
    });
  };

  const updateFavoriteModels = (
    instanceId: ProviderInstanceId,
    nextFavorites: ReadonlyArray<string>,
  ) => {
    const favoriteModels = [
      ...new Set(
        Arr.filterMap(nextFavorites, (slug) => {
          const trimmed = slug.trim();
          return trimmed.length > 0 ? Result.succeed(trimmed) : Result.failVoid;
        }),
      ),
    ];
    updateSettings({
      favorites: [
        ...(settings.favorites ?? []).filter((favorite) => favorite.provider !== instanceId),
        ...favoriteModels.map((model) => ({ provider: instanceId, model })),
      ],
    });
  };

  const liveProviderFor = (instanceId: ProviderInstanceId): ServerProvider | undefined =>
    serverProviders.find((candidate) => candidate.instanceId === instanceId);

  return (
    <>
      <SettingsSection
        id="provider-instances"
        title={rows.length > 1 ? t("Instances") : t("Configuration")}
        headerAction={
          <div className="flex items-center gap-1">
            <Button
              size="xs"
              variant="ghost-muted"
              disabled={isRefreshing}
              onClick={refreshProviders}
              aria-label={t("Refresh {provider} status", { provider: providerLabel })}
            >
              {isRefreshing ? (
                <LoaderIcon className="size-3.5 animate-spin" />
              ) : (
                <RefreshCwIcon className="size-3.5" />
              )}
              {t("Refresh")}
            </Button>
            <Button size="xs" variant="ghost-muted" onClick={() => setIsAddDialogOpen(true)}>
              <PlusIcon className="size-3.5" />
              {t("Add instance")}
            </Button>
          </div>
        }
      >
        {rows.length === 0 ? (
          <SettingsMessageRow>
            {t(
              "This environment has no {provider} runtime. Update the environment server to configure it here.",
              { provider: providerLabel },
            )}
          </SettingsMessageRow>
        ) : (
          rows.map((row) => {
            const liveProvider = liveProviderFor(row.instanceId);
            const updateCandidate = liveProvider
              ? updateCandidateByInstanceId.get(liveProvider.instanceId)
              : undefined;
            const showUpdate =
              updateCandidate !== undefined &&
              hasOneClickUpdateProviderCandidate(updateCandidate, serverProviders);
            const canUpdate =
              updateCandidate !== undefined &&
              canOneClickUpdateProviderCandidate(updateCandidate, serverProviders) &&
              !updatingDrivers.has(updateCandidate.driver);
            const isUpdating =
              updateCandidate !== undefined &&
              (updatingDrivers.has(updateCandidate.driver) ||
                serverProviders.some(
                  (provider) =>
                    provider.driver === updateCandidate.driver && isProviderUpdateActive(provider),
                ));
            const preferences = settings.providerModelPreferences?.[row.instanceId] ?? {
              hiddenModels: [],
              modelOrder: [],
            };
            const favoriteModels = Arr.filterMap(settings.favorites ?? [], (favorite) =>
              favorite.provider === row.instanceId
                ? Result.succeed(favorite.model)
                : Result.failVoid,
            );
            const driverOption = getDriverOption(row.driver);
            return (
              <ProviderInstanceCard
                key={row.instanceId}
                instanceId={row.instanceId}
                instance={row.instance}
                driverOption={driverOption}
                liveProvider={liveProvider}
                isExpanded={expanded[row.instanceId] ?? false}
                onExpandedChange={(open) =>
                  setExpanded((existing) => ({ ...existing, [row.instanceId]: open }))
                }
                onUpdate={(next) => updateInstance(row, next)}
                onDelete={row.isDefault ? undefined : () => deleteInstance(row.instanceId)}
                accountContent={
                  account && !row.isDefault ? (
                    <ProviderAccountSection
                      environmentId={environmentId}
                      definition={account}
                      instanceId={row.instanceId}
                    />
                  ) : undefined
                }
                headerAction={
                  row.isDefault && row.isDirty ? (
                    <SettingResetButton
                      label={t("{provider} provider settings", {
                        provider: driverOption?.label ?? String(row.driver),
                      })}
                      onClick={() => resetDefaultInstance(row.driver)}
                    />
                  ) : null
                }
                hiddenModels={preferences.hiddenModels}
                favoriteModels={favoriteModels}
                modelOrder={preferences.modelOrder}
                onHiddenModelsChange={(hiddenModels) =>
                  updateModelPreferences(row.instanceId, { ...preferences, hiddenModels })
                }
                onFavoriteModelsChange={(favorites) =>
                  updateFavoriteModels(row.instanceId, favorites)
                }
                onModelOrderChange={(modelOrder) =>
                  updateModelPreferences(row.instanceId, { ...preferences, modelOrder })
                }
                onRunUpdate={
                  showUpdate && updateCandidate
                    ? () => {
                        if (canUpdate) void runProviderUpdate(updateCandidate);
                      }
                    : undefined
                }
                isUpdating={showUpdate ? isUpdating : undefined}
              />
            );
          })
        )}
      </SettingsSection>

      {isAddDialogOpen ? (
        <AddProviderInstanceDialog
          open
          environmentId={environmentId}
          environmentLabel={environment?.label ?? t("this environment")}
          {...(drivers[0] ? { initialDriver: drivers[0] } : {})}
          onOpenChange={setIsAddDialogOpen}
        />
      ) : null}
    </>
  );
}
