"use client";

import type { ProviderConfig } from "./providerConfig";

import { type KeyboardEvent, useMemo, useState } from "react";
import {
  ProviderInstanceId,
  ProviderDriverKind,
  type EnvironmentId,
  type ProviderInstanceConfig,
} from "@akeru/contracts";

import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { toastManager } from "../ui/toast";
import type { DriverOption } from "./providerDriverMeta";
import { ProviderSettingsForm, readProviderConfigString } from "./ProviderSettingsForm";
import { AnimatedHeight } from "../AnimatedHeight";
import {
  addAccountWizardSteps,
  deriveInstanceId,
  isSubmitEnter,
  nextAccountNumber,
} from "./AddProviderInstanceDialog.logic";
import { AddProviderInstanceWizardSteps } from "./AddProviderInstanceWizardSteps";
import { CustomApiKeyDraftField } from "./CustomApiKeyField";
import { CustomApiPresetPicker } from "./CustomApiPresetPicker";
import {
  customApiKeyHint,
  OTHER_CUSTOM_API_PRESET,
  withCustomApiKey,
  type CustomApiPreset,
} from "./customApiPresets";

const CUSTOM_API_DRIVER_KIND = ProviderDriverKind.make("customOpenai");

interface AddProviderInstanceDialogProps {
  readonly open: boolean;
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  /** Name of the provider page that opened the dialog, such as ChatGPT. */
  readonly providerLabel?: string;
  /** Provider whose page opened the dialog. The new account uses its driver. */
  readonly driverOption: DriverOption;
  readonly onOpenChange: (open: boolean) => void;
}

export function AddProviderInstanceDialog({
  open,
  environmentId,
  environmentLabel,
  providerLabel,
  driverOption,
  onOpenChange,
}: AddProviderInstanceDialogProps) {
  const settings = useEnvironmentSettings(environmentId);
  const updateSettings = useUpdateEnvironmentSettings(environmentId);

  const [wizardStep, setWizardStep] = useState(0);

  const driver = driverOption.value;

  const isCustomApi = driver === CUSTOM_API_DRIVER_KIND;

  const [label, setLabel] = useState("");
  // A preset names the instance until the user types a label of their own.
  const [labelEdited, setLabelEdited] = useState(false);
  const [customApiPreset, setCustomApiPreset] = useState<CustomApiPreset>(OTHER_CUSTOM_API_PRESET);
  const [customApiKey, setCustomApiKey] = useState("");
  const [configDraft, setConfigDraftState] = useState<ProviderConfig>({});

  const existingIds = useMemo(
    () => new Set(Object.keys(settings.providerInstances ?? {})),
    [settings.providerInstances],
  );

  const accountLabel = providerLabel ?? driverOption.label;

  const usedNames = useMemo(
    () =>
      new Set(
        Object.values(settings.providerInstances ?? {}).flatMap((instance) =>
          instance.displayName ? [instance.displayName.trim()] : [],
        ),
      ),
    [settings.providerInstances],
  );

  const nameTaken = (index: number) => usedNames.has(`${accountLabel} ${index}`);
  const instanceId = deriveInstanceId(driver, label, existingIds, nameTaken);
  // A blank name still gets one, so the new account never shares another's.
  const fallbackName = `${accountLabel} ${nextAccountNumber(driver, existingIds, nameTaken)}`;
  const accountName = label.trim() || fallbackName;

  // The driver cannot reach a Custom API service without its address.
  const canSave =
    !isCustomApi || readProviderConfigString(configDraft, "baseUrl").trim().length > 0;

  const wizardSteps = addAccountWizardSteps({ choosesService: isCustomApi });

  const lastStep = wizardSteps.length - 1;
  const currentStepName = wizardSteps[wizardStep];
  const nameSummary = label.trim() || null;

  const wizardStepSummaries = wizardSteps.map((step) => {
    if (step === "Service") return customApiPreset.label;

    return step === "Name" ? nameSummary : null;
  });

  const setConfigDraft = (config: ProviderConfig | undefined) => setConfigDraftState(config ?? {});

  const chooseCustomApiPreset = (preset: CustomApiPreset) => {
    // A key belongs to one service; never send it to the next endpoint.
    if (preset.id !== customApiPreset.id) setCustomApiKey("");

    setCustomApiPreset(preset);

    if (!labelEdited) setLabel(preset === OTHER_CUSTOM_API_PRESET ? "" : preset.label);

    setConfigDraftState(({ baseUrl: _omit, ...rest }) =>
      preset.baseUrl ? { ...rest, baseUrl: preset.baseUrl } : rest,
    );
  };

  const handleSave = () => {
    if (!canSave) return;

    const config = configDraft;
    const hasConfig = Object.keys(config).length > 0;

    const environment = isCustomApi ? withCustomApiKey([], customApiKey) : [];

    const nextInstance: ProviderInstanceConfig = {
      driver,
      enabled: true,
      displayName: accountName,
      ...(hasConfig ? { config } : {}),
      ...(environment.length > 0 ? { environment } : {}),
    };

    // The id is derived from the name and always fits the slug rules;
    // the brand constructor keeps the type boundary honest.
    const brandedId = ProviderInstanceId.make(instanceId);

    const nextMap = {
      ...settings.providerInstances,
      [brandedId]: nextInstance,
    };

    try {
      updateSettings({ providerInstances: nextMap });
      toastManager.add({
        type: "success",
        title: "Account added",
        description: `${accountName} was added. Sign in or connect it from its card.`,
      });
      onOpenChange(false);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not add account",
        description: error instanceof Error ? error.message : "Update failed.",
      });
    }
  };

  const advanceOnEnter = (event: KeyboardEvent<HTMLElement>) => {
    const isSubmit = isSubmitEnter({
      key: event.key,
      keyCode: event.keyCode,
      isComposing: event.nativeEvent.isComposing,
    });

    if (!isSubmit || !(event.target instanceof HTMLInputElement)) return;

    event.preventDefault();

    if (wizardStep < lastStep) setWizardStep(wizardStep + 1);
    else handleSave();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-xl overflow-hidden">
        <div className="flex min-h-0 flex-col overflow-hidden">
          <DialogHeader>
            <DialogTitle>
              {isCustomApi ? "Connect a service" : `Add ${accountLabel} account`}
            </DialogTitle>
            <DialogDescription>
              {isCustomApi
                ? `Add another OpenAI-compatible service on ${environmentLabel}. Each one keeps its own address and key.`
                : `Add another ${accountLabel} account on ${environmentLabel}. Each account keeps its own sign-in and settings.`}
            </DialogDescription>
            {wizardSteps.length > 1 ? (
              <AddProviderInstanceWizardSteps
                steps={wizardSteps}
                currentStep={wizardStep}
                summaries={wizardStepSummaries}
                onStepChange={setWizardStep}
              />
            ) : null}
          </DialogHeader>

          <div
            data-slot="dialog-panel"
            className="space-y-4 bg-inset-surface/80 px-6 py-5 ring-1 ring-tint/5 dark:bg-tint/2"
          >
            <AnimatedHeight>
              <div className="grid gap-4">
                {isCustomApi ? (
                  <div className={cn(currentStepName !== "Service" && "hidden")}>
                    <CustomApiPresetPicker
                      value={customApiPreset.id}
                      onChange={chooseCustomApiPreset}
                    />
                  </div>
                ) : null}

                <label className={cn("grid gap-2", currentStepName !== "Name" && "hidden")}>
                  <span className="text-xs font-medium text-foreground">
                    Name <span className="font-normal text-muted-foreground">(optional)</span>
                  </span>
                  <Input
                    surface="background"
                    placeholder={fallbackName}
                    value={label}
                    autoFocus={!isCustomApi}
                    onChange={(event) => {
                      setLabel(event.target.value);
                      setLabelEdited(true);
                    }}
                    onKeyDown={advanceOnEnter}
                  />
                  <span className="text-11px text-muted-foreground">
                    Leave it blank to call it {fallbackName}. Press Enter to continue.
                  </span>
                </label>

                {isCustomApi ? (
                  <div
                    className={cn("grid gap-4", currentStepName !== "Connect" && "hidden")}
                    onKeyDown={advanceOnEnter}
                  >
                    <ProviderSettingsForm
                      definition={driverOption}
                      value={configDraft}
                      idPrefix={`add-provider-${driver}`}
                      variant="dialog"
                      onChange={setConfigDraft}
                    />
                    <CustomApiKeyDraftField
                      id="add-provider-custom-api-key"
                      value={customApiKey}
                      required={customApiPreset.key.kind === "required"}
                      hint={customApiKeyHint(customApiPreset)}
                      onChange={setCustomApiKey}
                    />
                  </div>
                ) : null}
              </div>
            </AnimatedHeight>
          </div>

          <DialogFooter variant="bare">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                if (wizardStep === 0) {
                  onOpenChange(false);

                  return;
                }

                setWizardStep((step) => Math.max(0, step - 1));
              }}
            >
              {wizardStep === 0 ? "Cancel" : "Back"}
            </Button>
            {wizardStep < lastStep ? (
              <Button size="sm" onClick={() => setWizardStep(wizardStep + 1)}>
                Next
              </Button>
            ) : (
              <Button size="sm" disabled={!canSave} onClick={handleSave}>
                {isCustomApi ? "Connect" : "Add account"}
              </Button>
            )}
          </DialogFooter>
        </div>
      </DialogPopup>
    </Dialog>
  );
}
