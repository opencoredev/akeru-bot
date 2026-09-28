import {
  MEMORY_SETTING_DISABLED_HINT,
  SHARED_PROJECT_MEMORY_SETTING,
  sharedProjectMemoryAutoSaves,
  sharedProjectMemoryMode,
} from "@t3tools/client-runtime/durable-memory";
import { AKERU_MARKETING_SITE_URL, DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts/settings";

import type { MessageKey } from "@t3tools/client-runtime/i18n";

import { usePrimarySettings, useUpdatePrimarySettings } from "~/hooks/useSettings";
import { useI18n } from "../../i18n";
import { Switch } from "../ui/switch";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { PortabilitySettings } from "./PortabilitySettings";
import { searchableSetting, type SettingsSearchItemId } from "./settingsSearch";

const privacyPolicyUrl = `${AKERU_MARKETING_SITE_URL}/privacy-policy`;
const termsUrl = `${AKERU_MARKETING_SITE_URL}/terms-of-service`;

export function PrivacySettingsPanel() {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const { t } = useI18n();
  const memoryHint = (description: MessageKey) =>
    settings.memory.enabled
      ? t(description)
      : `${t(description)} ${t(MEMORY_SETTING_DISABLED_HINT)}`;
  const translatedSetting = (id: SettingsSearchItemId) => searchableSetting(id, t);

  return (
    <SettingsPageContainer>
      <SettingsSection title={t("Data sharing")}>
        <SettingsRow
          {...searchableSetting("anonymous-analytics", t)}
          description={t(
            "Share anonymous usage counts and app details. Prompts, files, and provider account IDs are excluded.",
          )}
          resetAction={
            settings.analyticsEnabled !== DEFAULT_SERVER_SETTINGS.analyticsEnabled ? (
              <SettingResetButton
                label={t("anonymous analytics")}
                onClick={() =>
                  updateSettings({ analyticsEnabled: DEFAULT_SERVER_SETTINGS.analyticsEnabled })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.analyticsEnabled}
              onCheckedChange={(checked) => updateSettings({ analyticsEnabled: Boolean(checked) })}
              aria-label={t("Send anonymous analytics")}
            />
          }
        />
        <SettingsRow
          {...searchableSetting("privacy-product-feedback", t)}
          description={t(
            "Allow feedback you submit to reach the Akeru feedback service. Submissions may be kept for up to 90 days.",
          )}
          control={
            <Switch
              checked={settings.productFeedbackEnabled}
              onCheckedChange={(checked) =>
                updateSettings({ productFeedbackEnabled: Boolean(checked) })
              }
              aria-label={t("Enable product feedback")}
            />
          }
        />
        <SettingsRow
          {...searchableSetting("privacy-voice-calls", t)}
          description={t(
            "Allow calls through ChatGPT Realtime. Microphone audio and call data leave this environment during a call.",
          )}
          control={
            <Switch
              checked={settings.voice.enabled}
              onCheckedChange={(checked) =>
                updateSettings({ voice: { enabled: Boolean(checked) } })
              }
              aria-label={t("Enable voice calls")}
            />
          }
        />
      </SettingsSection>

      <SettingsSection title={t("Memory")}>
        <SettingsRow
          {...translatedSetting("memory-enabled")}
          description={t("Keep durable facts that bots can use across chats.")}
          control={
            <Switch
              checked={settings.memory.enabled}
              onCheckedChange={(checked) =>
                updateSettings({ memory: { enabled: Boolean(checked) } })
              }
              aria-label={t("Memory")}
            />
          }
        />
        <SettingsRow
          {...translatedSetting("memory-private-bot")}
          description={memoryHint("Let each bot keep facts about you that only that bot uses.")}
          control={
            <Switch
              checked={settings.memory.privateBotMemory}
              disabled={!settings.memory.enabled}
              onCheckedChange={(checked) =>
                updateSettings({ memory: { privateBotMemory: Boolean(checked) } })
              }
              aria-label={t("Private bot memory")}
            />
          }
        />
        <SettingsRow
          {...translatedSetting("memory-shared-project")}
          description={memoryHint(SHARED_PROJECT_MEMORY_SETTING.description)}
          control={
            <Switch
              checked={sharedProjectMemoryAutoSaves(settings.memory.sharedProjectMemory)}
              disabled={!settings.memory.enabled}
              onCheckedChange={(checked) =>
                updateSettings({
                  memory: { sharedProjectMemory: sharedProjectMemoryMode(Boolean(checked)) },
                })
              }
              aria-label={t(SHARED_PROJECT_MEMORY_SETTING.label)}
            />
          }
        />
      </SettingsSection>

      <SettingsSection title={t("Backup and transfer")}>
        <PortabilitySettings />
      </SettingsSection>

      <SettingsSection title={t("Other connections")}>
        <SettingsRow
          title={t("Desktop updates")}
          description={t(
            "Signed desktop builds contact the configured release host to check for and download updates.",
          )}
        />
      </SettingsSection>

      <SettingsSection title={t("Policies")}>
        <SettingsRow
          title={t("Read the terms and privacy policy")}
          description={
            <span className="flex gap-3">
              <a
                className="underline underline-offset-4"
                href={termsUrl}
                target="_blank"
                rel="noreferrer"
              >
                {t("Terms of Use")}
              </a>
              <a
                className="underline underline-offset-4"
                href={privacyPolicyUrl}
                target="_blank"
                rel="noreferrer"
              >
                {t("Privacy Policy")}
              </a>
            </span>
          }
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}
