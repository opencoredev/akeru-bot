import {
  CHATGPT_REALTIME_VOICES,
  DEFAULT_SERVER_SETTINGS,
  type ChatGptRealtimeVoice,
  type VoiceProvider,
} from "@t3tools/contracts";

import { usePrimarySettings, useUpdatePrimarySettings } from "~/hooks/useSettings";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { useSyncExternalStore } from "react";
import type { ReplyReadoutPreference } from "@t3tools/client-runtime/reply-playback";
import { useOptionalReplyPlayback } from "../chat/ReplyPlaybackProvider";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { ComposedVoiceRows, VoiceApiConnectionsSection } from "./VoiceApiSettings";
import { useI18n } from "../../i18n";

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

const VOICE_PROVIDERS: ReadonlyArray<VoiceProvider> = ["chatgpt", "openai", "composed"];

const VOICE_PROVIDER_LABELS: Readonly<Record<VoiceProvider, string>> = {
  chatgpt: "ChatGPT subscription",
  openai: "OpenAI API realtime",
  composed: "Transcription + bot + speech",
};

const VOICE_PROVIDER_DESCRIPTIONS: Readonly<Record<VoiceProvider, string>> = {
  chatgpt: "Use the ChatGPT subscription connected to this environment.",
  openai: "Talk in realtime through an OpenAI API key, billed to that API account.",
  composed:
    "Record what you say, run the bot's normal chat turn, then speak its reply with the services below.",
};

export function VoiceSettingsPanel() {
  const { t } = useI18n();
  const voice = usePrimarySettings((settings) => settings.voice);
  const updateSettings = useUpdatePrimarySettings();
  const replyPlayback = useOptionalReplyPlayback();
  const environmentId = usePrimaryEnvironmentId();
  // ChatGPT and OpenAI API realtime keep separate voice choices.
  const realtimeVoice = voice.provider === "openai" ? (voice.openaiVoice ?? "alloy") : voice.voice;
  const defaultRealtimeVoice = DEFAULT_SERVER_SETTINGS.voice.voice;

  const selectVoice = (value: string | null) => {
    const selected = CHATGPT_REALTIME_VOICES.find((candidate) => candidate === value);
    if (!selected) return;
    updateSettings({
      voice: voice.provider === "openai" ? { openaiVoice: selected } : { voice: selected },
    });
  };

  return (
    <SettingsPageContainer>
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
        <SettingsRow
          {...searchableSetting("voice-provider", t)}
          description={VOICE_PROVIDER_DESCRIPTIONS[voice.provider]}
          control={
            <Select
              value={voice.provider}
              onValueChange={(value) => {
                const provider = VOICE_PROVIDERS.find((candidate) => candidate === value);
                if (provider) updateSettings({ voice: { provider } });
              }}
              disabled={!voice.enabled}
            >
              <SelectTrigger className="w-full sm:w-52" aria-label="Voice provider">
                <SelectValue>{VOICE_PROVIDER_LABELS[voice.provider]}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {VOICE_PROVIDERS.map((provider) => (
                  <SelectItem key={provider} value={provider}>
                    {VOICE_PROVIDER_LABELS[provider]}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
        {replyPlayback ? <AutomaticReadoutRow preference={replyPlayback.preference} /> : null}
        {voice.provider === "composed" ? (
          environmentId ? (
            <ComposedVoiceRows
              environmentId={environmentId}
              voice={voice}
              onChange={(patch) => updateSettings({ voice: patch })}
            />
          ) : null
        ) : (
          <SettingsRow
            {...searchableSetting("voice-selection", t)}
            description="Choose the voice used for new calls."
            resetAction={
              voice.enabled && realtimeVoice !== defaultRealtimeVoice ? (
                <SettingResetButton
                  label="voice selection"
                  onClick={() =>
                    updateSettings({
                      voice:
                        voice.provider === "openai"
                          ? { openaiVoice: defaultRealtimeVoice }
                          : { voice: defaultRealtimeVoice },
                    })
                  }
                />
              ) : null
            }
            control={
              <Select value={realtimeVoice} onValueChange={selectVoice} disabled={!voice.enabled}>
                <SelectTrigger className="w-full sm:w-52" aria-label="Voice">
                  <SelectValue>{VOICE_LABELS[realtimeVoice]}</SelectValue>
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
        )}
      </SettingsSection>
      {environmentId ? <VoiceApiConnectionsSection environmentId={environmentId} /> : null}
    </SettingsPageContainer>
  );
}

function AutomaticReadoutRow({ preference }: { readonly preference: ReplyReadoutPreference }) {
  const { t } = useI18n();
  const state = useSyncExternalStore(
    preference.subscribe,
    preference.getSnapshot,
    preference.getSnapshot,
  );
  return (
    <SettingsRow
      {...searchableSetting("voice-read-aloud", t)}
      description={
        state.persistenceError
          ? "This preference could not be saved on this device."
          : "Read new completed replies in the open chat on this device. History is never replayed. This does not start a live call or generate a new answer."
      }
      control={
        <Switch
          checked={state.enabled}
          onCheckedChange={(checked) => {
            void preference.setEnabled(Boolean(checked));
          }}
          aria-label="Read new replies aloud"
        />
      }
    />
  );
}
