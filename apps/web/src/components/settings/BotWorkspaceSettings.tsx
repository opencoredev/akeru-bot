import { Match } from "effect";
import { useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import { type BotSandboxBrowserSharing, ProviderDriverKind } from "@akeru/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@akeru/contracts/settings";
import { createModelSelection } from "@akeru/shared/model";
import * as Equal from "effect/Equal";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { TraitsPicker } from "../chat/TraitsPicker";
import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import {
  getCustomModelOptionsByInstance,
  resolveAppModelSelectionState,
} from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { primaryServerProvidersAtom } from "../../state/server";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useI18n } from "../../i18n";
import type { MessageKey } from "@akeru/client-runtime/i18n";
import { DEFAULT_DRIVER_KIND } from "./useSettingsRestore";

const BOT_SANDBOX_BROWSER_SHARING_LABELS: Record<BotSandboxBrowserSharing, MessageKey> = {
  shared: "Shared",
  separate: "Separate",
};

export function BotSandboxBrowserSharingSettings({
  value,
  onChange,
}: {
  readonly value: BotSandboxBrowserSharing;
  readonly onChange: (value: BotSandboxBrowserSharing) => void;
}) {
  const { t } = useI18n();
  const [pendingValue, setPendingValue] = useState<BotSandboxBrowserSharing | null>(null);

  return (
    <>
      <SettingsRow
        {...searchableSetting("sandbox-browser-sharing", t)}
        description={t(
          "Shared uses one sandbox and browser for every bot. Separate gives each bot its own sandbox and browser profile.",
        )}
        resetAction={
          value !== DEFAULT_UNIFIED_SETTINGS.botSandboxBrowserSharing ? (
            <SettingResetButton
              label={t("sandbox and browser sharing")}
              onClick={() => setPendingValue(DEFAULT_UNIFIED_SETTINGS.botSandboxBrowserSharing)}
            />
          ) : null
        }
        control={
          <Select
            value={value}
            onValueChange={(nextValue) => {
              if ((nextValue === "shared" || nextValue === "separate") && nextValue !== value) {
                setPendingValue(nextValue);
              }
            }}
          >
            <SelectTrigger className="w-full sm:w-40" aria-label={t("Sandbox and browser sharing")}>
              <SelectValue>{t(BOT_SANDBOX_BROWSER_SHARING_LABELS[value])}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              <SelectItem hideIndicator value="shared">
                {t(BOT_SANDBOX_BROWSER_SHARING_LABELS.shared)}
              </SelectItem>
              <SelectItem hideIndicator value="separate">
                {t(BOT_SANDBOX_BROWSER_SHARING_LABELS.separate)}
              </SelectItem>
            </SelectPopup>
          </Select>
        }
      />

      <Dialog open={pendingValue !== null} onOpenChange={(open) => !open && setPendingValue(null)}>
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>{t("Change bot workspace mode?")}</DialogTitle>
            <DialogDescription>
              {pendingValue === "shared"
                ? t(
                    "Active bot work keeps its current workspace. The next turn moves each bot into the shared workspace and browser. Files and cookies do not move.",
                  )
                : t(
                    "Active bot work keeps its current workspace. The next turn creates a separate workspace and browser for each bot. Shared files and cookies stay in the shared workspace.",
                  )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingValue(null)}>
              {t("Cancel")}
            </Button>
            <Button
              onClick={() => {
                const nextValue = pendingValue;
                setPendingValue(null);

                if (nextValue) onChange(nextValue);
              }}
            >
              {t("Change mode")}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}

/** Model used for chat titles and other background text when nothing else picks one. */
export function FallbackModelSettingsRow() {
  const { t } = useI18n();
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const serverProviders = useAtomValue(primaryServerProvidersAtom);
  const textGenerationModelSelection = resolveAppModelSelectionState(settings, serverProviders);
  const textGenInstanceId = textGenerationModelSelection.instanceId;
  const textGenModel = textGenerationModelSelection.model;
  const textGenModelOptions = textGenerationModelSelection.options;

  const textGenerationModelInstanceEntries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(deriveProviderInstanceEntries(serverProviders), settings),
  );

  const textGenInstanceEntry = textGenerationModelInstanceEntries.find(
    (entry) => entry.instanceId === textGenInstanceId,
  );

  const textGenProvider: ProviderDriverKind =
    textGenInstanceEntry?.driverKind ?? DEFAULT_DRIVER_KIND;

  const textGenerationModelOptionsByInstance = getCustomModelOptionsByInstance(
    settings,
    serverProviders,
    textGenInstanceId,
    textGenModel,
  );

  const isTextGenerationModelDirty = !Equal.equals(
    settings.textGenerationModelSelection ?? null,
    DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection ?? null,
  );

  return (
    <SettingsRow
      id="text-generation-model"
      title={t("Fallback model")}
      description={t("Writes chat titles and other short background text.")}
      resetAction={
        isTextGenerationModelDirty ? (
          <SettingResetButton
            label={t("text generation model")}
            onClick={() =>
              updateSettings({
                textGenerationModelSelection: DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection,
              })
            }
          />
        ) : null
      }
      control={
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          <ProviderModelPicker
            activeInstanceId={textGenInstanceId}
            model={textGenModel}
            lockedProvider={null}
            instanceEntries={textGenerationModelInstanceEntries}
            modelOptionsByInstance={textGenerationModelOptionsByInstance}
            triggerVariant="outline"
            triggerClassName="min-w-0 max-w-none shrink-0 text-foreground/90 hover:text-foreground"
            onInstanceModelChange={(instanceId, model) => {
              updateSettings({
                textGenerationModelSelection: resolveAppModelSelectionState(
                  {
                    ...settings,
                    textGenerationModelSelection: createModelSelection(instanceId, model),
                  },
                  serverProviders,
                ),
              });
            }}
          />
          <TraitsPicker
            provider={textGenProvider}
            models={
              // Use the exact instance's models (rather than the
              // first-kind-match) so a custom text-gen instance like
              // `codex_personal` gets its own model list, not the
              // default Codex one.
              textGenInstanceEntry?.models ?? []
            }
            model={textGenModel}
            prompt=""
            onPromptChange={() => {}}
            modelOptions={textGenModelOptions}
            allowPromptInjectedEffort={false}
            triggerVariant="outline"
            triggerClassName="min-w-0 max-w-none shrink-0 text-foreground/90 hover:text-foreground"
            onModelOptionsChange={(nextOptions) => {
              updateSettings({
                textGenerationModelSelection: resolveAppModelSelectionState(
                  {
                    ...settings,
                    textGenerationModelSelection: createModelSelection(
                      textGenInstanceId,
                      textGenModel,
                      nextOptions,
                    ),
                  },
                  serverProviders,
                ),
              });
            }}
          />
        </div>
      }
    />
  );
}

/** Environment-wide workspace policy shared by every bot. */
export function BotWorkspaceSettingsSection() {
  const { t } = useI18n();
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();

  return (
    <SettingsSection title={t("Workspace")}>
      <BotSandboxBrowserSharingSettings
        value={settings.botSandboxBrowserSharing}
        onChange={(value) => updateSettings({ botSandboxBrowserSharing: value })}
      />
      <SettingsRow
        {...searchableSetting("local-execution", t)}
        description={t("Auto review runs safe actions and asks before sensitive ones.")}
        resetAction={
          settings.localExecutionMode !== DEFAULT_UNIFIED_SETTINGS.localExecutionMode ? (
            <SettingResetButton
              label={t("local execution")}
              onClick={() =>
                updateSettings({
                  localExecutionMode: DEFAULT_UNIFIED_SETTINGS.localExecutionMode,
                })
              }
            />
          ) : null
        }
        control={
          <Select
            value={settings.localExecutionMode}
            onValueChange={(value) => {
              if (value === "approval-required" || value === "auto" || value === "full-access") {
                updateSettings({ localExecutionMode: value });
              }
            }}
          >
            <SelectTrigger className="w-full sm:w-40" aria-label={t("Local execution")}>
              <SelectValue>
                {Match.value(settings).pipe(
                  Match.when({ localExecutionMode: "full-access" }, () => t("Full access")),
                  Match.when({ localExecutionMode: "approval-required" }, () => t("Ask first")),
                  Match.orElse(() => t("Auto review")),
                )}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              <SelectItem hideIndicator value="auto">
                {t("Auto review")}
              </SelectItem>
              <SelectItem hideIndicator value="approval-required">
                {t("Ask first")}
              </SelectItem>
              <SelectItem hideIndicator value="full-access">
                {t("Full access")}
              </SelectItem>
            </SelectPopup>
          </Select>
        }
      />
    </SettingsSection>
  );
}
