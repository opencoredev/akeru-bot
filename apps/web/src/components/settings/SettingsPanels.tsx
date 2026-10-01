import { SettingsIcon } from "lucide-react";
import type { CSSProperties } from "react";
import { useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import {
  DEFAULT_ENVIRONMENT_IDENTIFICATION_MODE,
  DEFAULT_UNIFIED_SETTINGS,
  type EnvironmentIdentificationMode,
  MAX_APPEARANCE_CONTRAST,
  MAX_GLASS_OPACITY,
  MIN_APPEARANCE_CONTRAST,
  MIN_GLASS_OPACITY,
} from "@akeru/contracts/settings";
import { resolveServerBackgroundActivitySettings } from "@akeru/shared/backgroundActivitySettings";
import * as Equal from "effect/Equal";
import * as Exit from "effect/Exit";
import {
  resolveEnvironmentIdentificationPillLabel,
  useEnvironmentStageLabel,
} from "../SidebarStageBackdrop";
import { openSettings } from "../../settingsDialogStore";
import { useCustomThemes } from "../../hooks/useCustomThemes";
import { useTheme } from "../../hooks/useTheme";
import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import { primaryServerObservabilityAtom } from "../../state/server";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ThemeLibrary } from "./ThemeSettings";
import {
  formatDiagnosticsDescription,
  resolveBackgroundActivityProfileOption,
} from "./SettingsPanels.logic";
import {
  PolicyTooltip,
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useI18n } from "../../i18n";
import type { MessageKey } from "@akeru/client-runtime/i18n";
import {
  decodeProductFeedbackEndpoint,
  resetBackgroundActivitySettings,
} from "./useSettingsRestore";
import {
  BACKGROUND_ACTIVITY_PROFILE_LABELS,
  BACKGROUND_ACTIVITY_PROFILE_OPTION_LABELS,
  BACKGROUND_ACTIVITY_PROFILE_DESCRIPTIONS,
  backgroundActivityProfileSettings,
  BackgroundActivityAdvancedDialog,
} from "./BackgroundActivitySettings";
import { TypographySection } from "./TypographySettings";
import { LegacyFeaturesSection } from "./LegacyFeatureSettings";

const ENVIRONMENT_IDENTIFICATION_LABELS: Record<EnvironmentIdentificationMode, MessageKey> = {
  artwork: "Artwork",
  pill: "Version pill",
  none: "None",
};

export function AppearanceSettingsPanel() {
  const {
    appearanceMode,
    refreshTheme,
    resolvedTheme,
    setAppearanceMode,
    setTheme,
    setThemeHalf,
    theme,
    themeHalves,
  } = useTheme();

  const { t } = useI18n();
  const customThemes = useCustomThemes();
  const [isImportThemeOpen, setIsImportThemeOpen] = useState(false);
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const environmentStageLabel = useEnvironmentStageLabel();

  const showEnvironmentIdentification =
    resolveEnvironmentIdentificationPillLabel(environmentStageLabel) !== null;

  const glassOpacityRatio =
    (settings.glassOpacity - MIN_GLASS_OPACITY) / (MAX_GLASS_OPACITY - MIN_GLASS_OPACITY);

  // SAFETY: React CSSProperties omits custom properties; these values are CSS variables consumed by the component stylesheet.
  const glassOpacitySliderStyle = {
    "--settings-slider-progress": `${glassOpacityRatio * 100}%`,
    "--settings-slider-fill-offset": `${0.5 - glassOpacityRatio}rem`,
  } as CSSProperties;

  const appearanceContrastRatio =
    (settings.appearanceContrast - MIN_APPEARANCE_CONTRAST) /
    (MAX_APPEARANCE_CONTRAST - MIN_APPEARANCE_CONTRAST);

  // SAFETY: React CSSProperties omits custom properties; these values are CSS variables consumed by the component stylesheet.
  const appearanceContrastSliderStyle = {
    "--settings-slider-progress": `${appearanceContrastRatio * 100}%`,
    "--settings-slider-fill-offset": `${0.5 - appearanceContrastRatio}rem`,
  } as CSSProperties;

  return (
    <SettingsPageContainer>
      {/* Renders the Color scheme (`#appearance`) and Themes sections. */}
      <ThemeLibrary
        appearanceMode={appearanceMode}
        customThemes={customThemes}
        initialAppearance={resolvedTheme}
        refreshTheme={refreshTheme}
        isImportOpen={isImportThemeOpen}
        setAppearanceMode={setAppearanceMode}
        setTheme={setTheme}
        setThemeHalf={setThemeHalf}
        theme={theme}
        themeHalves={themeHalves}
        onImportOpenChange={setIsImportThemeOpen}
      />

      <SettingsSection id="display" title={t("Display")}>
        <SettingsRow
          {...searchableSetting("setting-appearance-contrast", t)}
          description={t("Adjust the contrast of colors and borders across the interface.")}
          resetAction={
            settings.appearanceContrast !== DEFAULT_UNIFIED_SETTINGS.appearanceContrast ? (
              <SettingResetButton
                label={t("contrast")}
                onClick={() =>
                  updateSettings({
                    appearanceContrast: DEFAULT_UNIFIED_SETTINGS.appearanceContrast,
                  })
                }
              />
            ) : null
          }
          control={
            <div className="flex w-full items-center gap-3 sm:w-52">
              <output
                className="min-w-12 rounded-md bg-settings-control px-2 py-1 text-center font-mono text-xs font-medium tabular-nums text-foreground"
                htmlFor="appearance-contrast"
              >
                {settings.appearanceContrast}%
              </output>
              <input
                aria-label={t("Contrast")}
                className="settings-slider min-w-0 flex-1"
                id="appearance-contrast"
                max={MAX_APPEARANCE_CONTRAST}
                min={MIN_APPEARANCE_CONTRAST}
                onChange={(event) => {
                  const appearanceContrast = Number(event.currentTarget.value);

                  if (
                    Number.isInteger(appearanceContrast) &&
                    appearanceContrast >= MIN_APPEARANCE_CONTRAST &&
                    appearanceContrast <= MAX_APPEARANCE_CONTRAST
                  ) {
                    updateSettings({ appearanceContrast });
                  }
                }}
                step={5}
                style={appearanceContrastSliderStyle}
                type="range"
                value={settings.appearanceContrast}
              />
            </div>
          }
        />

        <SettingsRow
          {...searchableSetting("setting-glass-opacity", t)}
          description={t(
            "Control how transparent glass surfaces are. Higher values make menus, dialogs, and the composer more solid.",
          )}
          resetAction={
            settings.glassOpacity !== DEFAULT_UNIFIED_SETTINGS.glassOpacity ? (
              <SettingResetButton
                label={t("glass opacity")}
                onClick={() =>
                  updateSettings({ glassOpacity: DEFAULT_UNIFIED_SETTINGS.glassOpacity })
                }
              />
            ) : null
          }
          control={
            <div className="flex w-full items-center gap-3 sm:w-52">
              <output
                className="min-w-12 rounded-md bg-settings-control px-2 py-1 text-center font-mono text-xs font-medium tabular-nums text-foreground"
                htmlFor="glass-opacity"
              >
                {settings.glassOpacity}%
              </output>
              <input
                aria-label={t("Glass opacity")}
                className="settings-slider min-w-0 flex-1"
                id="glass-opacity"
                max={MAX_GLASS_OPACITY}
                min={MIN_GLASS_OPACITY}
                onChange={(event) => {
                  const glassOpacity = Number(event.currentTarget.value);

                  if (
                    Number.isInteger(glassOpacity) &&
                    glassOpacity >= MIN_GLASS_OPACITY &&
                    glassOpacity <= MAX_GLASS_OPACITY
                  ) {
                    updateSettings({ glassOpacity });
                  }
                }}
                step={5}
                style={glassOpacitySliderStyle}
                type="range"
                value={settings.glassOpacity}
              />
            </div>
          }
        />

        {showEnvironmentIdentification ? (
          <SettingsRow
            {...searchableSetting("environment-identification", t)}
            description={t("Choose how Dev environments are identified.")}
            resetAction={
              settings.environmentIdentificationMode !== DEFAULT_ENVIRONMENT_IDENTIFICATION_MODE ? (
                <SettingResetButton
                  label={t("environment identification")}
                  onClick={() =>
                    updateSettings({
                      environmentIdentificationMode: DEFAULT_ENVIRONMENT_IDENTIFICATION_MODE,
                    })
                  }
                />
              ) : null
            }
            control={
              <Select
                value={settings.environmentIdentificationMode}
                onValueChange={(value) => {
                  if (value === "artwork" || value === "pill" || value === "none") {
                    updateSettings({ environmentIdentificationMode: value });
                  }
                }}
              >
                <SelectTrigger
                  className="w-full sm:w-40"
                  aria-label={t("Environment identification")}
                >
                  <SelectValue>
                    {t(ENVIRONMENT_IDENTIFICATION_LABELS[settings.environmentIdentificationMode])}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  {Object.entries(ENVIRONMENT_IDENTIFICATION_LABELS).map(([value, label]) => (
                    <SelectItem hideIndicator key={value} value={value}>
                      {t(label)}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            }
          />
        ) : null}
      </SettingsSection>

      <TypographySection />
    </SettingsPageContainer>
  );
}

/** Performance and troubleshooting controls for the Advanced page. */
export function AdvancedSettingsSections() {
  const { t } = useI18n();
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const [backgroundActivityDialogOpen, setBackgroundActivityDialogOpen] = useState(false);
  const observability = useAtomValue(primaryServerObservabilityAtom);

  const diagnosticsDescription = formatDiagnosticsDescription(
    {
      localTracingEnabled: observability?.localTracingEnabled ?? false,
      otlpTracesEnabled: observability?.otlpTracesEnabled ?? false,
      otlpTracesUrl: observability?.otlpTracesUrl,
      otlpMetricsEnabled: observability?.otlpMetricsEnabled ?? false,
      otlpMetricsUrl: observability?.otlpMetricsUrl,
    },
    t,
  );

  const resolvedBackgroundActivity = resolveServerBackgroundActivitySettings(settings);
  const activeBackgroundActivityProfile = resolvedBackgroundActivity.profile;
  const backgroundActivityProfileOption = resolveBackgroundActivityProfileOption(settings);

  const backgroundActivityDescription =
    backgroundActivityProfileOption === "advanced"
      ? t(
          "Uses custom background intervals with the selected shared power policy. Current shared policy: {profile}.",
          { profile: t(BACKGROUND_ACTIVITY_PROFILE_LABELS[activeBackgroundActivityProfile]) },
        )
      : t(BACKGROUND_ACTIVITY_PROFILE_DESCRIPTIONS[resolvedBackgroundActivity.profile]);

  const canResetBackgroundActivity = !Equal.equals(
    settings.backgroundActivity,
    DEFAULT_UNIFIED_SETTINGS.backgroundActivity,
  );

  return (
    <>
      <SettingsSection title={t("Performance")}>
        <SettingsRow
          id={searchableSetting("background-activity").id}
          title={
            <span className="inline-flex items-center gap-1.5">
              {t("Background work")}
              <PolicyTooltip>
                {t(
                  "This shared policy gates background work such as Git refreshes and provider health probes after their individual intervals elapse.",
                )}
              </PolicyTooltip>
            </span>
          }
          description={backgroundActivityDescription}
          resetAction={
            canResetBackgroundActivity ? (
              <SettingResetButton
                label={t("background work")}
                onClick={() => updateSettings(resetBackgroundActivitySettings())}
              />
            ) : null
          }
          control={
            <>
              <Select
                value={backgroundActivityProfileOption}
                onValueChange={(value) => {
                  if (value === "advanced") {
                    setBackgroundActivityDialogOpen(true);

                    return;
                  }

                  if (
                    value === "balanced" ||
                    value === "performance" ||
                    value === "battery-saver"
                  ) {
                    updateSettings(backgroundActivityProfileSettings(value));
                  }
                }}
              >
                <SelectTrigger className="w-full sm:w-40" aria-label={t("Background work profile")}>
                  <SelectValue>
                    {t(BACKGROUND_ACTIVITY_PROFILE_OPTION_LABELS[backgroundActivityProfileOption])}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  <SelectItem hideIndicator value="balanced">
                    {t(BACKGROUND_ACTIVITY_PROFILE_LABELS.balanced)}
                  </SelectItem>
                  <SelectItem hideIndicator value="performance">
                    {t(BACKGROUND_ACTIVITY_PROFILE_LABELS.performance)}
                  </SelectItem>
                  <SelectItem hideIndicator value="battery-saver">
                    {t(BACKGROUND_ACTIVITY_PROFILE_LABELS["battery-saver"])}
                  </SelectItem>
                  <SelectItem hideIndicator value="advanced">
                    {t(BACKGROUND_ACTIVITY_PROFILE_OPTION_LABELS.advanced)}
                  </SelectItem>
                </SelectPopup>
              </Select>
              {backgroundActivityProfileOption === "advanced" ? (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        size="icon-sm"
                        variant="outline"
                        aria-label={t("Configure advanced background activity")}
                        onClick={() => setBackgroundActivityDialogOpen(true)}
                      >
                        <SettingsIcon className="size-4" />
                      </Button>
                    }
                  />
                  <TooltipPopup side="top">{t("Configure background activity")}</TooltipPopup>
                </Tooltip>
              ) : null}
              <BackgroundActivityAdvancedDialog
                open={backgroundActivityDialogOpen}
                onOpenChange={setBackgroundActivityDialogOpen}
              />
            </>
          }
        />
      </SettingsSection>

      <SettingsSection title={t("Troubleshooting")}>
        <SettingsRow
          {...searchableSetting("diagnostics", t)}
          description={
            <>
              {t("Inspect logs, resource use, and tracing for this environment.")}{" "}
              {diagnosticsDescription}
            </>
          }
          control={
            <Button size="xs" variant="outline" onClick={() => openSettings("diagnostics")}>
              {t("View diagnostics")}
            </Button>
          }
        />
        <SettingsRow
          title={t("Feedback endpoint")}
          description={t("Where submitted product feedback is sent. Use HTTPS or loopback HTTP.")}
          control={
            <Input
              aria-label={t("Feedback endpoint")}
              className="w-full sm:w-80"
              defaultValue={settings.productFeedbackEndpoint}
              key={settings.productFeedbackEndpoint}
              onBlur={(event) => {
                const decoded = decodeProductFeedbackEndpoint(event.currentTarget.value);

                if (Exit.isFailure(decoded)) {
                  event.currentTarget.value = settings.productFeedbackEndpoint;
                  toastManager.add({
                    type: "error",
                    title: t("Use HTTPS or loopback HTTP."),
                  });

                  return;
                }

                const productFeedbackEndpoint = decoded.value;

                if (
                  productFeedbackEndpoint &&
                  productFeedbackEndpoint !== settings.productFeedbackEndpoint
                ) {
                  updateSettings({ productFeedbackEndpoint });
                }
              }}
            />
          }
        />
      </SettingsSection>

      <LegacyFeaturesSection />
    </>
  );
}

export { useSettingsRestore } from "./useSettingsRestore";

export {
  BotSandboxBrowserSharingSettings,
  FallbackModelSettingsRow,
  BotWorkspaceSettingsSection,
} from "./BotWorkspaceSettings";
