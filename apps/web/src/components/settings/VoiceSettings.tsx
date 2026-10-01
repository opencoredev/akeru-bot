import { DEFAULT_SERVER_SETTINGS } from "@akeru/contracts";
import { useMemo, useState } from "react";
import { usePrimarySettings, useUpdatePrimarySettings } from "~/hooks/useSettings";
import { usePrimaryEnvironment } from "~/state/environments";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentQuery } from "../../state/query";
import { Switch } from "../ui/switch";
import { useOptionalReplyPlayback } from "../chat/ReplyPlaybackProvider";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useI18n } from "../../i18n";
import { VoiceModeRows } from "./VoiceModeSettings";
import { VoiceApiConnectionsSection } from "./VoiceApiConnections";
import { AutomaticReadoutRow } from "./VoiceReadoutSettings";

/** Voice rows for the Providers page, which supplies the page container. */
export function VoiceSettingsSection() {
  const { t } = useI18n();
  const voice = usePrimarySettings((settings) => settings.voice);
  const updateSettings = useUpdatePrimarySettings();
  const replyPlayback = useOptionalReplyPlayback();
  const environmentId = usePrimaryEnvironment()?.environmentId ?? null;

  const providersQuery = useEnvironmentQuery(
    environmentId ? serverEnvironment.voiceProviders({ environmentId, input: {} }) : null,
  );

  // Bumped when a key is saved so the voice list reloads for the new account.
  const [keyRevision, setKeyRevision] = useState(0);

  const connected = useMemo(
    () =>
      providersQuery.data
        ? providersQuery.data.providers.filter((status) => status.connected).map((s) => s.provider)
        : null,
    [providersQuery.data],
  );

  // The server keeps each saved key's last Test verdict, so every client agrees.
  const serverRejected = useMemo(
    () =>
      providersQuery.data
        ? Object.fromEntries(
            providersQuery.data.providers.flatMap((status) =>
              status.keyRejected === undefined ? [] : [[status.provider, status.keyRejected]],
            ),
          )
        : {},
    [providersQuery.data],
  );

  return (
    <>
      <SettingsSection id="voice" title="Voice">
        <SettingsRow
          {...searchableSetting("voice-enabled", t)}
          description="Allow bots with Voice calls enabled to start voice calls."
          resetAction={
            voice.enabled !== DEFAULT_SERVER_SETTINGS.voice.enabled ? (
              <SettingResetButton
                label="voice"
                onClick={() =>
                  updateSettings({ voice: { enabled: DEFAULT_SERVER_SETTINGS.voice.enabled } })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={voice.enabled}
              onCheckedChange={(checked) =>
                updateSettings({ voice: { enabled: Boolean(checked) } })
              }
              aria-label="Enable voice"
            />
          }
        />
        <VoiceModeRows
          voice={voice}
          environmentId={environmentId}
          connected={connected}
          keyRevision={keyRevision}
          onChange={updateSettings}
        />
        {replyPlayback ? <AutomaticReadoutRow preference={replyPlayback.preference} /> : null}
      </SettingsSection>
      {environmentId ? (
        <VoiceApiConnectionsSection
          key={environmentId}
          environmentId={environmentId}
          connected={connected}
          serverRejected={serverRejected}
          loadError={providersQuery.error}
          onChanged={providersQuery.refresh}
          onKeySaved={() => setKeyRevision((revision) => revision + 1)}
        />
      ) : null}
    </>
  );
}

export { VoiceModeRows } from "./VoiceModeSettings";

export { VoiceApiProviderRow } from "./VoiceApiConnections";
