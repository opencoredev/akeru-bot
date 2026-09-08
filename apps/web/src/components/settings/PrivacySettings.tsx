import { AKERU_MARKETING_SITE_URL, DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts/settings";

import { usePrimarySettings, useUpdatePrimarySettings } from "~/hooks/useSettings";
import { Switch } from "../ui/switch";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const privacyPolicyUrl = `${AKERU_MARKETING_SITE_URL}/privacy-policy`;
const termsUrl = `${AKERU_MARKETING_SITE_URL}/terms-of-service`;

export function PrivacySettingsPanel() {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();

  return (
    <SettingsPageContainer>
      <SettingsSection title="Privacy controls">
        <SettingsRow
          {...searchableSetting("anonymous-analytics")}
          description="Send app version, platform, architecture, client type, and feature events to PostHog. Akeru Bot does not use provider account IDs."
          resetAction={
            settings.analyticsEnabled !== DEFAULT_SERVER_SETTINGS.analyticsEnabled ? (
              <SettingResetButton
                label="anonymous analytics"
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
              aria-label="Send anonymous analytics"
            />
          }
        />
        <SettingsRow
          {...searchableSetting("privacy-product-feedback")}
          description="Send feedback you submit to the Akeru feedback service. The service keeps submissions for up to 90 days."
          control={
            <Switch
              checked={settings.productFeedbackEnabled}
              onCheckedChange={(checked) =>
                updateSettings({ productFeedbackEnabled: Boolean(checked) })
              }
              aria-label="Enable product feedback"
            />
          }
        />
        <SettingsRow
          {...searchableSetting("privacy-voice-calls")}
          description="Send live microphone audio and session data to the ChatGPT Realtime service during a call."
          control={
            <Switch
              checked={settings.voice.enabled}
              onCheckedChange={(checked) =>
                updateSettings({ voice: { enabled: Boolean(checked) } })
              }
              aria-label="Enable voice calls"
            />
          }
        />
        <SettingsRow
          {...searchableSetting("privacy-provider-update-checks")}
          description="Contact provider release sources to check for newer CLI versions."
          control={
            <Switch
              checked={settings.enableProviderUpdateChecks}
              onCheckedChange={(checked) =>
                updateSettings({ enableProviderUpdateChecks: Boolean(checked) })
              }
              aria-label="Enable provider update checks"
            />
          }
        />
      </SettingsSection>

      <SettingsSection title="Outbound data">
        <SettingsRow
          title="Provider CLIs"
          description="Prompts, selected files, tool results, screenshots, and conversation context go to the provider you choose. Provider terms and retention rules apply."
        />
        <SettingsRow
          title="Desktop updates"
          description="Signed desktop builds contact the configured release host to check for and download updates."
        />
      </SettingsSection>

      <SettingsSection title="Legal">
        <SettingsRow
          title="Policies"
          description={
            <span className="flex gap-3">
              <a
                className="underline underline-offset-4"
                href={termsUrl}
                target="_blank"
                rel="noreferrer"
              >
                Terms of Use
              </a>
              <a
                className="underline underline-offset-4"
                href={privacyPolicyUrl}
                target="_blank"
                rel="noreferrer"
              >
                Privacy Policy
              </a>
            </span>
          }
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}
