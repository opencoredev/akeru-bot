import { Link } from "@tanstack/react-router";
import { useCallback, useState } from "react";
import type { MessageKey } from "@t3tools/client-runtime/i18n";
import { DEFAULT_UNIFIED_SETTINGS, type QuitConfirmationMode } from "@t3tools/contracts/settings";

import { APP_VERSION } from "../../branding";
import {
  canCheckForUpdate,
  getDesktopUpdateButtonTooltip,
  getDesktopUpdateInstallConfirmationMessage,
  isDesktopUpdateButtonDisabled,
  resolveDesktopUpdateButtonAction,
} from "../../components/desktopUpdate.logic";
import { isElectron } from "../../env";
import { useI18n } from "../../i18n";
import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import { ensureLocalApi } from "../../localApi";
import { openProductFeedback } from "../../productFeedbackStore";
import { useDesktopUpdateState } from "../../state/desktopUpdate";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { LanguageSetting } from "./LanguageSetting";
import { searchableSetting } from "./settingsSearch";

// General is the default Settings page, so it ships in the main bundle instead
// of the lazy SettingsPanels chunk. Its values come from synchronous settings
// state, so the page renders complete on first paint. Keep imports light.

const TIMESTAMP_FORMAT_LABELS = {
  locale: "System default",
  "12-hour": "12-hour",
  "24-hour": "24-hour",
} as const satisfies Record<string, MessageKey>;

const QUIT_CONFIRMATION_MODE_LABELS: Record<QuitConfirmationMode, MessageKey> = {
  hold: "Hold",
  "double-click": "Double press",
  direct: "Direct",
};

function AboutVersionTitle() {
  const { t } = useI18n();
  return (
    <span className="inline-flex items-baseline gap-2">
      <span>{t("Version")}</span>
      <code className="text-[11px] font-medium text-muted-foreground">{APP_VERSION}</code>
    </span>
  );
}

function AboutVersionSection() {
  const { t } = useI18n();
  const updateState = useDesktopUpdateState();
  const [isUpdateActionPending, setIsUpdateActionPending] = useState(false);

  const handleButtonClick = useCallback(async () => {
    const bridge = window.desktopBridge;
    if (!bridge) return;

    const action = updateState ? resolveDesktopUpdateButtonAction(updateState) : "none";

    if (action === "download") {
      void bridge.downloadUpdate().catch((error: unknown) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: t("Could not download update"),
            description: error instanceof Error ? error.message : t("Download failed."),
          }),
        );
      });
      return;
    }

    if (action === "install") {
      if (isUpdateActionPending) return;
      setIsUpdateActionPending(true);
      let confirmed = false;
      try {
        confirmed = await ensureLocalApi().dialogs.confirm(
          getDesktopUpdateInstallConfirmationMessage(
            updateState ?? { availableVersion: null, downloadedVersion: null },
          ),
        );
      } catch (error) {
        setIsUpdateActionPending(false);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: t("Could not confirm update"),
            description: error instanceof Error ? error.message : t("Update confirmation failed."),
          }),
        );
        return;
      }
      if (!confirmed) {
        setIsUpdateActionPending(false);
        return;
      }
      void bridge
        .installUpdate()
        .catch((error: unknown) => {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: t("Could not install update"),
              description: error instanceof Error ? error.message : t("Install failed."),
            }),
          );
        })
        .finally(() => setIsUpdateActionPending(false));
      return;
    }

    if (typeof bridge.checkForUpdate !== "function") return;
    void bridge
      .checkForUpdate()
      .then((result) => {
        if (!result.checked) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: t("Could not check for updates"),
              description:
                result.state.message ?? t("Automatic updates are not available in this build."),
            }),
          );
        }
      })
      .catch((error: unknown) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: t("Could not check for updates"),
            description: error instanceof Error ? error.message : t("Update check failed."),
          }),
        );
      });
  }, [isUpdateActionPending, t, updateState]);

  const action = updateState ? resolveDesktopUpdateButtonAction(updateState) : "none";
  const buttonTooltip = updateState ? getDesktopUpdateButtonTooltip(updateState) : null;
  const buttonDisabled =
    action === "none"
      ? !canCheckForUpdate(updateState)
      : isDesktopUpdateButtonDisabled(updateState);

  const actionLabel: Record<string, MessageKey> = { download: "Download", install: "Install" };
  const statusLabel: Record<string, MessageKey> = {
    checking: "Checking…",
    downloading: "Downloading…",
    "up-to-date": "Up to Date",
  };
  const buttonLabel = t(
    actionLabel[action] ?? statusLabel[updateState?.status ?? ""] ?? "Check for Updates",
  );
  const description =
    action === "download" || action === "install"
      ? t("Update available.")
      : t("Current version of the application.");

  return (
    <SettingsRow
      title={<AboutVersionTitle />}
      description={description}
      control={
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="xs"
                variant="outline"
                disabled={buttonDisabled || isUpdateActionPending}
                onClick={handleButtonClick}
              >
                {buttonLabel}
              </Button>
            }
          />
          {buttonTooltip ? <TooltipPopup>{buttonTooltip}</TooltipPopup> : null}
        </Tooltip>
      }
    />
  );
}

/** "How often the usage page reloads plan limits.", with the page name as a link. */
function UsageRefreshDescription() {
  const { t } = useI18n();
  const [beforeLink, afterLink = ""] = t("How often the {link} reloads plan limits.", {
    link: "\u0000",
  }).split("\u0000");
  return (
    <>
      {beforeLink}
      <Link to="/usage" className="text-foreground underline underline-offset-2">
        {t("usage page")}
      </Link>
      {afterLink}
    </>
  );
}

export function GeneralSettingsPanel() {
  const { t } = useI18n();
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();

  return (
    <SettingsPageContainer>
      <SettingsSection title={t("Preferences")}>
        <LanguageSetting />
        <SettingsRow
          {...searchableSetting("time-format", t)}
          description={t("System default follows your browser or OS clock preference.")}
          resetAction={
            settings.timestampFormat !== DEFAULT_UNIFIED_SETTINGS.timestampFormat ? (
              <SettingResetButton
                label={t("time format")}
                onClick={() =>
                  updateSettings({
                    timestampFormat: DEFAULT_UNIFIED_SETTINGS.timestampFormat,
                  })
                }
              />
            ) : null
          }
          control={
            <Select
              value={settings.timestampFormat}
              onValueChange={(value) => {
                if (value === "locale" || value === "12-hour" || value === "24-hour") {
                  updateSettings({ timestampFormat: value });
                }
              }}
            >
              <SelectTrigger className="w-full sm:w-40" aria-label={t("Timestamp format")}>
                <SelectValue>{t(TIMESTAMP_FORMAT_LABELS[settings.timestampFormat])}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem hideIndicator value="locale">
                  {t(TIMESTAMP_FORMAT_LABELS.locale)}
                </SelectItem>
                <SelectItem hideIndicator value="12-hour">
                  {t(TIMESTAMP_FORMAT_LABELS["12-hour"])}
                </SelectItem>
                <SelectItem hideIndicator value="24-hour">
                  {t(TIMESTAMP_FORMAT_LABELS["24-hour"])}
                </SelectItem>
              </SelectPopup>
            </Select>
          }
        />

        <SettingsRow
          {...searchableSetting("usage-refresh", t)}
          description={<UsageRefreshDescription />}
          resetAction={
            settings.usageRefreshMinutes !== DEFAULT_UNIFIED_SETTINGS.usageRefreshMinutes ? (
              <SettingResetButton
                label={t("usage refresh")}
                onClick={() =>
                  updateSettings({
                    usageRefreshMinutes: DEFAULT_UNIFIED_SETTINGS.usageRefreshMinutes,
                  })
                }
              />
            ) : null
          }
          control={
            <Select
              value={String(settings.usageRefreshMinutes)}
              onValueChange={(value) => {
                const minutes = Number(value);
                if (minutes === 1 || minutes === 5 || minutes === 15 || minutes === 30) {
                  updateSettings({ usageRefreshMinutes: minutes });
                }
              }}
            >
              <SelectTrigger className="w-full sm:w-40" aria-label={t("Usage refresh")}>
                <SelectValue>
                  {t("{count} min", { count: settings.usageRefreshMinutes })}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem hideIndicator value="1">
                  {t("{count} min", { count: 1 })}
                </SelectItem>
                <SelectItem hideIndicator value="5">
                  {t("{count} min", { count: 5 })}
                </SelectItem>
                <SelectItem hideIndicator value="15">
                  {t("{count} min", { count: 15 })}
                </SelectItem>
                <SelectItem hideIndicator value="30">
                  {t("{count} min", { count: 30 })}
                </SelectItem>
              </SelectPopup>
            </Select>
          }
        />

        {isElectron ? (
          <SettingsRow
            {...searchableSetting("quit-confirmation", t)}
            description={t("Hold mode also quits on two quick presses.")}
            resetAction={
              settings.confirmQuit !== DEFAULT_UNIFIED_SETTINGS.confirmQuit ? (
                <SettingResetButton
                  label={t("quit shortcut behavior")}
                  onClick={() =>
                    updateSettings({ confirmQuit: DEFAULT_UNIFIED_SETTINGS.confirmQuit })
                  }
                />
              ) : null
            }
            control={
              <Select
                value={settings.confirmQuit}
                onValueChange={(value) => {
                  if (value === "direct" || value === "hold" || value === "double-click") {
                    updateSettings({ confirmQuit: value });
                  }
                }}
              >
                <SelectTrigger
                  size="sm"
                  className="w-full sm:w-40"
                  aria-label={t("Quit shortcut behavior")}
                >
                  <SelectValue>
                    {t(QUIT_CONFIRMATION_MODE_LABELS[settings.confirmQuit])}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  {(
                    Object.entries(QUIT_CONFIRMATION_MODE_LABELS) as Array<
                      [QuitConfirmationMode, MessageKey]
                    >
                  ).map(([value, label]) => (
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

      <SettingsSection title={t("About")}>
        {isElectron ? (
          <AboutVersionSection />
        ) : (
          <SettingsRow
            title={<AboutVersionTitle />}
            description={t("Current version of the application.")}
          />
        )}
        <SettingsRow
          title={t("Send feedback")}
          control={
            <Button size="xs" variant="outline" onClick={() => openProductFeedback()}>
              {t("Send feedback")}
            </Button>
          }
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}
