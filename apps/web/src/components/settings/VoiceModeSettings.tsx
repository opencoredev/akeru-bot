import {
  CHATGPT_REALTIME_VOICES,
  DEFAULT_SERVER_SETTINGS,
  type ChatGptRealtimeVoice,
  type EnvironmentId,
  type VoiceApiProvider,
  type VoiceSettings,
} from "@akeru/contracts";
import { useEffect, useState } from "react";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useI18n } from "../../i18n";
import {
  VOICE_API_PROVIDER_LABELS,
  VOICE_MODE_DESCRIPTIONS,
  VOICE_MODE_LABELS,
  VOICE_SYNTHESIS_PROVIDERS,
  VOICE_TRANSCRIPTION_PROVIDERS,
  selectedSynthesisVoice,
  voiceSetupProblem,
} from "./voiceSettings.logic";
import { commandError } from "./VoiceApiConnections";

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

const VOICE_MODES = ["chatgpt", "openai", "composed"] as const;

type VoicePatch = { readonly voice: Partial<VoiceSettings> };

/** Mode choice plus the rows that apply to the chosen mode. Changing mode never touches keys. */
export function VoiceModeRows({
  voice,
  environmentId,
  connected,
  keyRevision = 0,
  onChange,
}: {
  readonly voice: VoiceSettings;
  readonly environmentId: EnvironmentId | null;
  readonly connected: ReadonlyArray<VoiceApiProvider> | null;
  /** Changes when a voice key is saved, which reloads the voice list. */
  readonly keyRevision?: number;
  readonly onChange: (patch: VoicePatch) => void;
}) {
  const { t } = useI18n();
  const problem = voice.enabled ? voiceSetupProblem(voice, connected) : null;
  const synthesisProvider = voice.synthesisProvider ?? "openai";
  const openaiVoice = voice.openaiVoice ?? "alloy";

  return (
    <>
      <SettingsRow
        {...searchableSetting("voice-provider", t)}
        description={VOICE_MODE_DESCRIPTIONS[voice.provider]}
        status={problem ? <span className="text-destructive">{problem}</span> : null}
        control={
          <Select
            value={voice.provider}
            onValueChange={(value) => {
              const provider = VOICE_MODES.find((mode) => mode === value);
              if (provider) onChange({ voice: { provider } });
            }}
            disabled={!voice.enabled}
          >
            <SelectTrigger className="w-full sm:w-52" aria-label="Voice provider">
              <SelectValue>{VOICE_MODE_LABELS[voice.provider]}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {VOICE_MODES.map((mode) => (
                <SelectItem key={mode} value={mode}>
                  {VOICE_MODE_LABELS[mode]}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      {voice.provider === "chatgpt" ? (
        <SettingsRow
          {...searchableSetting("voice-selection", t)}
          description="Choose the voice used for new ChatGPT subscription calls."
          resetAction={
            voice.enabled && voice.voice !== DEFAULT_SERVER_SETTINGS.voice.voice ? (
              <SettingResetButton
                label="voice selection"
                onClick={() => onChange({ voice: { voice: DEFAULT_SERVER_SETTINGS.voice.voice } })}
              />
            ) : null
          }
          control={
            <RealtimeVoiceSelect
              value={voice.voice}
              disabled={!voice.enabled}
              label="Voice"
              onChange={(selected) => onChange({ voice: { voice: selected } })}
            />
          }
        />
      ) : null}
      {voice.provider === "openai" ? (
        <SettingsRow
          {...searchableSetting("voice-openai-voice", t)}
          description="Choose the voice used for new OpenAI API calls."
          control={
            <RealtimeVoiceSelect
              value={openaiVoice}
              disabled={!voice.enabled}
              label="OpenAI API voice"
              onChange={(selected) => onChange({ voice: { openaiVoice: selected } })}
            />
          }
        />
      ) : null}
      {voice.provider === "composed" ? (
        <>
          <SettingsRow
            {...searchableSetting("voice-transcription-provider", t)}
            description="Turns what you say into a chat message for the bot."
            control={
              <ProviderSelect
                value={voice.transcriptionProvider ?? "openai"}
                providers={VOICE_TRANSCRIPTION_PROVIDERS}
                disabled={!voice.enabled}
                label="Transcription provider"
                onChange={(transcriptionProvider) => onChange({ voice: { transcriptionProvider } })}
              />
            }
          />
          <SettingsRow
            {...searchableSetting("voice-synthesis-provider", t)}
            description="Speaks the bot's reply."
            control={
              <ProviderSelect
                value={synthesisProvider}
                providers={VOICE_SYNTHESIS_PROVIDERS}
                disabled={!voice.enabled}
                label="Speech provider"
                onChange={(provider) => onChange({ voice: { synthesisProvider: provider } })}
              />
            }
          />
          <SettingsRow
            {...searchableSetting("voice-synthesis-voice", t)}
            description={`Voices come from your ${VOICE_API_PROVIDER_LABELS[synthesisProvider]} account.`}
            control={
              environmentId ? (
                <SynthesisVoicePicker
                  key={`${synthesisProvider}:${connected?.includes(synthesisProvider) ?? false}:${keyRevision}`}
                  environmentId={environmentId}
                  provider={synthesisProvider}
                  connected={connected?.includes(synthesisProvider) ?? false}
                  value={selectedSynthesisVoice(voice)}
                  disabled={!voice.enabled}
                  onChange={(id) =>
                    onChange({
                      voice: {
                        synthesisVoices: { ...voice.synthesisVoices, [synthesisProvider]: id },
                      },
                    })
                  }
                />
              ) : null
            }
          />
        </>
      ) : null}
    </>
  );
}

function RealtimeVoiceSelect({
  value,
  disabled,
  label,
  onChange,
}: {
  readonly value: ChatGptRealtimeVoice;
  readonly disabled: boolean;
  readonly label: string;
  readonly onChange: (voice: ChatGptRealtimeVoice) => void;
}) {
  return (
    <Select
      value={value}
      onValueChange={(next) => {
        const selected = CHATGPT_REALTIME_VOICES.find((candidate) => candidate === next);
        if (selected) onChange(selected);
      }}
      disabled={disabled}
    >
      <SelectTrigger className="w-full sm:w-52" aria-label={label}>
        <SelectValue>{VOICE_LABELS[value]}</SelectValue>
      </SelectTrigger>
      <SelectPopup align="end" alignItemWithTrigger={false}>
        {CHATGPT_REALTIME_VOICES.map((candidate) => (
          <SelectItem key={candidate} value={candidate}>
            {VOICE_LABELS[candidate]}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

function ProviderSelect<P extends VoiceApiProvider>({
  value,
  providers,
  disabled,
  label,
  onChange,
}: {
  readonly value: P;
  readonly providers: ReadonlyArray<P>;
  readonly disabled: boolean;
  readonly label: string;
  readonly onChange: (provider: P) => void;
}) {
  return (
    <Select
      value={value}
      onValueChange={(next) => {
        const selected = providers.find((provider) => provider === next);
        if (selected) onChange(selected);
      }}
      disabled={disabled}
    >
      <SelectTrigger className="w-full sm:w-52" aria-label={label}>
        <SelectValue>{VOICE_API_PROVIDER_LABELS[value]}</SelectValue>
      </SelectTrigger>
      <SelectPopup align="end" alignItemWithTrigger={false}>
        {providers.map((provider) => (
          <SelectItem key={provider} value={provider}>
            {VOICE_API_PROVIDER_LABELS[provider]}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

function SynthesisVoicePicker({
  environmentId,
  provider,
  connected,
  value,
  disabled,
  onChange,
}: {
  readonly environmentId: EnvironmentId;
  readonly provider: VoiceApiProvider;
  readonly connected: boolean;
  readonly value: string | undefined;
  readonly disabled: boolean;
  readonly onChange: (voice: string) => void;
}) {
  const listVoices = useAtomCommand(serverEnvironment.listVoiceVoices, { reportFailure: false });
  const [voices, setVoices] = useState<ReadonlyArray<{ id: string; name: string }>>([]);
  const [nextCursor, setNextCursor] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async (cursor: string | undefined) => {
    setLoading(true);
    setError(null);
    const result = await listVoices({
      environmentId,
      input: cursor === undefined ? { provider } : { provider, cursor },
    });
    setLoading(false);
    if (result._tag === "Failure") return setError(commandError(result));
    if (result._tag !== "Success") return;
    setVoices((current) => (cursor === undefined ? [] : current).concat(result.value.voices));
    setNextCursor(result.value.nextCursor);
  };

  useEffect(() => {
    if (connected) void load(undefined);
    // The picker is keyed by provider and connection, so this runs once per pair.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!connected) {
    return (
      <span className="text-xs text-muted-foreground">
        Connect {VOICE_API_PROVIDER_LABELS[provider]} to choose a voice.
      </span>
    );
  }
  const options =
    value && !voices.some((voice) => voice.id === value)
      ? [{ id: value, name: value }, ...voices]
      : voices;
  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-1.5">
        <Select
          value={value ?? ""}
          onValueChange={(next) => {
            if (typeof next === "string" && next.length > 0) onChange(next);
          }}
          disabled={disabled || options.length === 0}
        >
          <SelectTrigger className="w-full sm:w-52" aria-label="Speech voice">
            <SelectValue>
              {options.find((voice) => voice.id === value)?.name ??
                (loading ? "Loading voices…" : "Choose a voice")}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {options.map((voice) => (
              <SelectItem key={voice.id} value={voice.id}>
                {voice.name}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        {nextCursor ? (
          <Button
            size="xs"
            variant="outline"
            disabled={loading}
            onClick={() => void load(nextCursor)}
          >
            More voices
          </Button>
        ) : null}
      </div>
      {error ? (
        <span role="alert" className="text-xs text-destructive">
          {error}
        </span>
      ) : null}
    </div>
  );
}
