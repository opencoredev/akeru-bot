import {
  CHATGPT_REALTIME_VOICES,
  DEFAULT_SERVER_SETTINGS,
  VOICE_API_PROVIDERS,
  type ChatGptRealtimeVoice,
  type EnvironmentId,
  type VoiceApiProvider,
  type VoiceSettings,
} from "@t3tools/contracts";
import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { LoaderIcon } from "lucide-react";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";

import { usePrimarySettings, useUpdatePrimarySettings } from "~/hooks/useSettings";
import { usePrimaryEnvironment } from "~/state/environments";
import { requestConfirmDialog } from "../../confirmDialog";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import type { ReplyReadoutPreference } from "@t3tools/client-runtime/reply-playback";
import { useOptionalReplyPlayback } from "../chat/ReplyPlaybackProvider";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useI18n } from "../../i18n";
import {
  VOICE_API_PROVIDER_LABELS,
  VOICE_MODE_DESCRIPTIONS,
  VOICE_MODE_LABELS,
  VOICE_SYNTHESIS_PROVIDERS,
  VOICE_TRANSCRIPTION_PROVIDERS,
  selectedSynthesisVoice,
  voiceCapabilityLabel,
  voiceSetupProblem,
} from "./voiceSettings.logic";

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

function commandError(result: AtomCommandResult<unknown, unknown>): string {
  if (result._tag !== "Failure") return "The request failed.";
  const error = squashAtomCommandFailure(result);
  return error instanceof Error ? error.message : "The request failed.";
}

export function VoiceSettingsPanel() {
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
          environmentId={environmentId}
          connected={connected}
          loadError={providersQuery.error}
          onChanged={providersQuery.refresh}
          onKeySaved={() => setKeyRevision((revision) => revision + 1)}
        />
      ) : null}
    </SettingsPageContainer>
  );
}

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

type ProviderMessage = { readonly tone: "error" | "ok"; readonly text: string };

function VoiceApiConnectionsSection({
  environmentId,
  connected,
  loadError,
  onChanged,
  onKeySaved,
}: {
  readonly environmentId: EnvironmentId;
  readonly connected: ReadonlyArray<VoiceApiProvider> | null;
  readonly loadError: string | null;
  readonly onChanged: () => void;
  readonly onKeySaved: () => void;
}) {
  const { t } = useI18n();
  const connect = useAtomCommand(serverEnvironment.connectVoiceProvider, { reportFailure: false });
  const disconnect = useAtomCommand(serverEnvironment.disconnectVoiceProvider, {
    reportFailure: false,
  });
  const test = useAtomCommand(serverEnvironment.testVoiceProvider, { reportFailure: false });
  const [busy, setBusy] = useState<{ provider: VoiceApiProvider; action: string } | null>(null);
  const [messages, setMessages] = useState<Partial<Record<VoiceApiProvider, ProviderMessage>>>({});

  const run = async (
    provider: VoiceApiProvider,
    action: string,
    call: () => Promise<AtomCommandResult<unknown, unknown>>,
    success: string,
  ): Promise<boolean> => {
    setBusy({ provider, action });
    setMessages((current) => ({ ...current, [provider]: undefined }));
    const result = await call();
    setBusy(null);
    const ok = result._tag === "Success";
    setMessages((current) => ({
      ...current,
      [provider]: ok
        ? { tone: "ok", text: success }
        : { tone: "error", text: commandError(result) },
    }));
    onChanged();
    return ok;
  };

  return (
    <SettingsSection title="API connections">
      <SettingsRow
        {...searchableSetting("voice-api-connections", t)}
        description="Keys stay on this environment and are never sent back to a client. API usage is billed by each provider, separately from your ChatGPT subscription."
        status={
          loadError ? (
            <span className="text-destructive">Could not load voice connections: {loadError}</span>
          ) : null
        }
      />
      {VOICE_API_PROVIDERS.map((provider) => (
        <VoiceApiProviderRow
          key={provider}
          provider={provider}
          connected={connected === null ? undefined : connected.includes(provider)}
          busyAction={busy?.provider === provider ? busy.action : null}
          disabled={busy !== null}
          message={messages[provider] ?? null}
          onConnect={async (apiKey) => {
            const saved = await run(
              provider,
              "connect",
              () => connect({ environmentId, input: { provider, apiKey } }),
              "Key saved. Run Test to check it with the provider.",
            );
            if (saved) onKeySaved();
            return saved;
          }}
          onTest={() =>
            void run(
              provider,
              "test",
              () => test({ environmentId, input: { provider } }),
              "The provider accepted this key.",
            )
          }
          onDisconnect={async () => {
            const label = VOICE_API_PROVIDER_LABELS[provider];
            const confirmed =
              (await requestConfirmDialog(
                `Remove the ${label} key from this environment? Voice settings that use ${label} stop working until you connect it again.`,
                { variant: "destructive" },
              )) ?? false;
            if (!confirmed) return;
            await run(
              provider,
              "disconnect",
              () => disconnect({ environmentId, input: { provider } }),
              "Key removed.",
            );
          }}
        />
      ))}
    </SettingsSection>
  );
}

export function VoiceApiProviderRow({
  provider,
  connected,
  busyAction,
  disabled,
  message,
  onConnect,
  onTest,
  onDisconnect,
}: {
  readonly provider: VoiceApiProvider;
  readonly connected: boolean | undefined;
  readonly busyAction: string | null;
  readonly disabled: boolean;
  readonly message: ProviderMessage | null;
  readonly onConnect: (apiKey: string) => Promise<boolean>;
  readonly onTest: () => void;
  readonly onDisconnect: () => void;
}) {
  const label = VOICE_API_PROVIDER_LABELS[provider];
  const [editing, setEditing] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const showInput = connected === false || editing;
  const spinner = (action: string) =>
    busyAction === action ? <LoaderIcon className="size-3 animate-spin" /> : null;

  const submit = async () => {
    const trimmed = apiKey.trim();
    if (!trimmed) return;
    if (await onConnect(trimmed)) {
      setApiKey("");
      setEditing(false);
    }
  };

  return (
    <SettingsRow
      title={
        <span className="flex items-center gap-2">
          {label}
          {connected === undefined ? null : (
            <Badge variant={connected ? "success" : "outline"} className="h-4 px-1.5 text-[10px]">
              {connected ? "Key saved" : "Not connected"}
            </Badge>
          )}
        </span>
      }
      description={voiceCapabilityLabel(provider)}
      status={
        message ? (
          <span
            role={message.tone === "error" ? "alert" : "status"}
            className={message.tone === "error" ? "text-destructive" : undefined}
          >
            {message.text}
          </span>
        ) : null
      }
      control={
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          {showInput ? (
            <form
              className="flex items-center gap-1.5"
              onSubmit={(event) => {
                event.preventDefault();
                void submit();
              }}
            >
              <Input
                type="password"
                size="sm"
                autoComplete="off"
                spellCheck={false}
                className="w-44"
                value={apiKey}
                onChange={(event) => setApiKey(event.currentTarget.value)}
                placeholder={`${label} API key`}
                aria-label={`${label} API key`}
              />
              <Button size="xs" type="submit" disabled={disabled || apiKey.trim().length === 0}>
                {spinner("connect")}
                {connected ? "Save key" : "Connect"}
              </Button>
              {editing ? (
                <Button
                  size="xs"
                  variant="ghost-muted"
                  type="button"
                  onClick={() => {
                    setApiKey("");
                    setEditing(false);
                  }}
                >
                  Cancel
                </Button>
              ) : null}
            </form>
          ) : null}
          {connected && !editing ? (
            <>
              <Button
                size="xs"
                variant="outline"
                disabled={disabled}
                onClick={onTest}
                aria-label={`Test ${label} key`}
              >
                {spinner("test")}
                Test
              </Button>
              <Button
                size="xs"
                variant="outline"
                disabled={disabled}
                onClick={() => setEditing(true)}
                aria-label={`Replace ${label} key`}
              >
                Replace key
              </Button>
              <Button
                size="xs"
                variant="ghost-muted"
                disabled={disabled}
                onClick={onDisconnect}
                aria-label={`Disconnect ${label}`}
              >
                {spinner("disconnect")}
                Disconnect
              </Button>
            </>
          ) : null}
        </div>
      }
    />
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
