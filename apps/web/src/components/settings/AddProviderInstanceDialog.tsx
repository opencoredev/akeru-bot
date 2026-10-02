"use client";

import type { ProviderConfig } from "./providerConfig";

import { useMemo, useState } from "react";
import {
  ProviderInstanceId,
  ProviderDriverKind,
  type EnvironmentId,
  type ProviderInstanceConfig,
} from "@akeru/contracts";

import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { normalizeProviderAccentColor } from "../../providerInstances";
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
import { ProviderSettingsForm, deriveProviderSettingsFields } from "./ProviderSettingsForm";
import { AnimatedHeight } from "../AnimatedHeight";
import {
  addAccountWizardSteps,
  resolveWizardNavigation,
  type WizardNavigation,
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

const PROVIDER_ACCENT_SWATCHES = [
  "#2563eb",
  "#16a34a",
  "#ea580c",
  "#dc2626",
  "#7c3aed",
  "#0891b2",
] as const;

/**
 * Normalize a user-provided name into a slug suffix for the account id.
 * The full id is formed by prefixing the driver slug — e.g. label "Work" on
 * driver "codex" becomes `codex_work`. Output is trimmed to 48 chars so the
 * final composed id stays under the 64-char slug cap enforced by
 * `ProviderInstanceId` in `@akeru/contracts`.
 */
function slugifyLabel(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
}

/**
 * Account id from the name, or `{driver}` when the name is empty, with the
 * first free `_{n}` suffix when that id is taken.
 */
function deriveInstanceId(
  driver: ProviderDriverKind,
  label: string,
  existing: ReadonlySet<string>,
): string {
  const slug = slugifyLabel(label);
  const base = slug ? `${driver}_${slug}` : driver;

  if (slug && !existing.has(base)) return base;

  let index = 2;

  while (existing.has(`${base}_${index}`)) index += 1;

  return `${base}_${index}`;
}

const INSTANCE_ID_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

const CUSTOM_API_DRIVER_KIND = ProviderDriverKind.make("customOpenai");

/**
 * Validate an account id against the same slug rules the server applies in
 * `ProviderInstanceId` (see `packages/contracts/src/providerInstance.ts`).
 * Returns a user-facing error string, or `null` if valid.
 */
function validateInstanceId(id: string, existing: ReadonlySet<string>): string | null {
  if (id.length === 0) return "Account ID is required.";

  if (id.length > 64) return "Account ID must be 64 characters or fewer.";

  if (!INSTANCE_ID_PATTERN.test(id)) {
    return "Account ID must start with a letter and use only letters, digits, '-', or '_'.";
  }

  if (existing.has(id)) return `An account named '${id}' already exists.`;

  return null;
}

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
  const [accentColor, setAccentColor] = useState<string>("");
  const [instanceIdOverride, setInstanceIdOverride] = useState<string | null>(null);
  const [configDraft, setConfigDraftState] = useState<ProviderConfig>({});
  // Errors are suppressed until the user has tried to submit once. After that
  // they update live so fixing the problem clears the message in place.
  const [hasAttemptedSubmit, setHasAttemptedSubmit] = useState(false);

  const existingIds = useMemo(
    () => new Set(Object.keys(settings.providerInstances ?? {})),
    [settings.providerInstances],
  );

  const accountLabel = providerLabel ?? driverOption.label;
  const instanceId = instanceIdOverride ?? deriveInstanceId(driver, label, existingIds);

  const driverSettingsFields = useMemo(
    () => deriveProviderSettingsFields(driverOption),
    [driverOption],
  );

  const instanceIdError = validateInstanceId(instanceId, existingIds);
  const showInstanceIdError = hasAttemptedSubmit && instanceIdError !== null;

  const wizardSteps = addAccountWizardSteps({
    choosesService: isCustomApi,
    hasSettings: driverSettingsFields.length > 0,
  });

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

  const applyWizardNavigation = (navigation: WizardNavigation) => {
    if (navigation.kind === "blocked") {
      setHasAttemptedSubmit(true);
    }

    setWizardStep(navigation.step);
  };

  const navigateToStep = (requestedStep: number) => {
    applyWizardNavigation(
      resolveWizardNavigation(wizardStep, requestedStep, wizardSteps, { instanceIdError }),
    );
  };

  const handleSave = () => {
    setHasAttemptedSubmit(true);

    if (instanceIdError !== null) return;

    const config = configDraft;
    const hasConfig = Object.keys(config).length > 0;
    const normalizedAccentColor = normalizeProviderAccentColor(accentColor);

    const environment = isCustomApi ? withCustomApiKey([], customApiKey) : [];

    const nextInstance: ProviderInstanceConfig = {
      driver,
      enabled: true,
      ...(label.trim().length > 0 ? { displayName: label.trim() } : {}),
      ...(normalizedAccentColor ? { accentColor: normalizedAccentColor } : {}),
      ...(hasConfig ? { config } : {}),
      ...(environment.length > 0 ? { environment } : {}),
    };

    // `ProviderInstanceId.make` revalidates the slug; we've already checked
    // it via `validateInstanceId`, but going through the brand constructor
    // keeps the type boundary honest and guards against any future drift in
    // the slug rules.
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
        description: `${label.trim() || accountLabel} was added. Sign in or connect it from its card.`,
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
                instanceIdError={instanceIdError}
                onNavigation={applyWizardNavigation}
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
                  <span className="text-xs font-medium text-foreground">Name</span>
                  <Input
                    surface="background"
                    placeholder="e.g. Work"
                    value={label}
                    onChange={(event) => {
                      setLabel(event.target.value);
                      setLabelEdited(true);
                    }}
                  />
                  <span className="text-11px text-muted-foreground">
                    Shown in the model picker and on this page. Optional.
                  </span>
                </label>

                <label className={cn("grid gap-2", currentStepName !== "Name" && "hidden")}>
                  <span className="text-xs font-medium text-foreground">Account ID</span>
                  <Input
                    surface="background"
                    placeholder={`${driver}_work`}
                    value={instanceId}
                    onChange={(event) => {
                      setInstanceIdOverride(event.target.value);
                    }}
                    aria-invalid={showInstanceIdError}
                  />
                  {showInstanceIdError ? (
                    <span className="text-11px text-destructive">{instanceIdError}</span>
                  ) : (
                    <span className="text-11px text-muted-foreground">
                      How bots and chats refer to this account. Letters, digits, '-', or '_'.
                    </span>
                  )}
                </label>

                <div className={cn("grid gap-2", currentStepName !== "Name" && "hidden")}>
                  <span className="text-xs font-medium text-foreground">Accent color</span>
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <input
                      type="color"
                      value={
                        normalizeProviderAccentColor(accentColor) ?? PROVIDER_ACCENT_SWATCHES[0]
                      }
                      onChange={(event) => setAccentColor(event.target.value)}
                      aria-label="Account accent color"
                      className="h-8 w-10 cursor-pointer rounded-xl border border-input bg-background p-0.5"
                    />
                    <div className="flex flex-wrap gap-1.5">
                      {PROVIDER_ACCENT_SWATCHES.map((swatch) => {
                        const selected = accentColor.toLowerCase() === swatch;

                        return (
                          <button
                            key={swatch}
                            type="button"
                            className={cn(
                              "size-6 cursor-pointer rounded-full border swatch-fill transition",
                              selected
                                ? "scale-110 border-foreground ring-2 ring-ring ring-offset-1 ring-offset-background"
                                : "border-tint/10 hover:scale-105 dark:border-tint/20",
                            )}
                            style={{ "--swatch": swatch }}
                            onClick={() => setAccentColor(swatch)}
                            aria-label={`Use ${swatch} accent`}
                          />
                        );
                      })}
                    </div>
                    {accentColor ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        presentation="wizard-preview-action"
                        onClick={() => setAccentColor("")}
                      >
                        Clear
                      </Button>
                    ) : null}
                  </div>
                  <span className="text-11px text-muted-foreground">
                    Optional marker shown in the picker.
                  </span>
                </div>

                {driverSettingsFields.length > 0 ? (
                  <div
                    className={cn(
                      "grid gap-4",
                      currentStepName !== "Connect" && currentStepName !== "Settings" && "hidden",
                    )}
                  >
                    <ProviderSettingsForm
                      definition={driverOption}
                      value={configDraft}
                      idPrefix={`add-provider-${driver}`}
                      variant="dialog"
                      onChange={setConfigDraft}
                    />
                    {isCustomApi ? (
                      <CustomApiKeyDraftField
                        id="add-provider-custom-api-key"
                        value={customApiKey}
                        required={customApiPreset.key.kind === "required"}
                        hint={customApiKeyHint(customApiPreset)}
                        onChange={setCustomApiKey}
                      />
                    ) : null}
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
              <Button size="sm" onClick={() => navigateToStep(wizardStep + 1)}>
                Next
              </Button>
            ) : (
              <Button size="sm" onClick={handleSave}>
                {isCustomApi ? "Connect" : "Add account"}
              </Button>
            )}
          </DialogFooter>
        </div>
      </DialogPopup>
    </Dialog>
  );
}
