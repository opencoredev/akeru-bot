import {
  CHATGPT_REALTIME_VOICES,
  DEFAULT_SERVER_SETTINGS,
  type ChatGptRealtimeVoice,
} from "@t3tools/contracts";

import { usePrimarySettings, useUpdatePrimarySettings } from "~/hooks/useSettings";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const VOICE_LABELS: Readonly<Record<ChatGptRealtimeVoice, string>> = {
  alloy: "Alloy",
  ash: "Ash",
  ballad: "Ballad",
  coral: "Coral",
  echo: "Echo",
  sage: "Sage",
  shimmer: "Shimmer",
  verse: "Verse",
  marin: "Marin",
  cedar: "Cedar",
};

export function VoiceSettingsPanel() {
  const voice = usePrimarySettings((settings) => settings.voice);
  const updateSettings = useUpdatePrimarySettings();

  const selectVoice = (value: string | null) => {
    const selected = CHATGPT_REALTIME_VOICES.find((candidate) => candidate === value);
    if (selected) updateSettings({ voice: { voice: selected } });
  };

  return (
    <SettingsPageContainer>
      <SettingsSection id="voice" title="Voice">
        <SettingsRow
          {...searchableSetting("voice-enabled")}
          description="Allow bots with Voice calls enabled to start subscription voice calls."
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
        <SettingsRow
          {...searchableSetting("voice-provider")}
          description="Use the ChatGPT subscription connected to this environment."
          control={
            <Select
              value={voice.provider}
              onValueChange={(provider) => {
                if (provider === "chatgpt") updateSettings({ voice: { provider } });
              }}
              disabled={!voice.enabled}
            >
              <SelectTrigger className="w-full sm:w-52" aria-label="Voice provider">
                <SelectValue>ChatGPT subscription</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem value="chatgpt">ChatGPT subscription</SelectItem>
              </SelectPopup>
            </Select>
          }
        />
        <SettingsRow
          {...searchableSetting("voice-selection")}
          description="Choose the voice used for new calls."
          resetAction={
            voice.enabled && voice.voice !== DEFAULT_SERVER_SETTINGS.voice.voice ? (
              <SettingResetButton
                label="voice selection"
                onClick={() =>
                  updateSettings({ voice: { voice: DEFAULT_SERVER_SETTINGS.voice.voice } })
                }
              />
            ) : null
          }
          control={
            <Select value={voice.voice} onValueChange={selectVoice} disabled={!voice.enabled}>
              <SelectTrigger className="w-full sm:w-52" aria-label="Voice">
                <SelectValue>{VOICE_LABELS[voice.voice]}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {CHATGPT_REALTIME_VOICES.map((candidate) => (
                  <SelectItem key={candidate} value={candidate}>
                    {VOICE_LABELS[candidate]}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}
