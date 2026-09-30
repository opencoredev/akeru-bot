import {
  VOICE_API_PROVIDERS,
  type EnvironmentId,
  type VoiceApiProvider,
  type VoiceSettings,
} from "@t3tools/contracts";
import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { LoaderIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { requestConfirmDialog } from "../../confirmDialog";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

export const VOICE_API_PROVIDER_LABELS: Readonly<Record<VoiceApiProvider, string>> = {
  openai: "OpenAI API",
  elevenlabs: "ElevenLabs",
  cartesia: "Cartesia",
  fish: "Fish Audio",
};

const TRANSCRIPTION_PROVIDERS = ["openai", "elevenlabs", "cartesia"] as const;

type VoicePatch = {
  readonly transcriptionProvider?: (typeof TRANSCRIPTION_PROVIDERS)[number];
  readonly synthesisProvider?: VoiceApiProvider;
  readonly synthesisVoices?: NonNullable<VoiceSettings["synthesisVoices"]>;
};

function commandError(result: AtomCommandResult<unknown, unknown>): string {
  if (result._tag !== "Failure") return "The request failed.";
  const error = squashAtomCommandFailure(result);
  return error instanceof Error ? error.message : "The request failed.";
}

/** Service and voice choices for composed calls: transcription, the bot's turn, then speech. */
export function ComposedVoiceRows({
  environmentId,
  voice,
  onChange,
}: {
  readonly environmentId: EnvironmentId;
  readonly voice: VoiceSettings;
  readonly onChange: (patch: VoicePatch) => void;
}) {
  const listVoices = useAtomCommand(serverEnvironment.listVoices, { reportFailure: false });
  const transcription = voice.transcriptionProvider ?? "openai";
  const synthesis = voice.synthesisProvider ?? "openai";
  const selectedVoice = voice.synthesisVoices?.[synthesis];
  const [voices, setVoices] = useState<{
    readonly provider: VoiceApiProvider;
    readonly items: ReadonlyArray<{ readonly id: string; readonly name: string }>;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const options = voices?.provider === synthesis ? voices.items : [];
  const selectedName =
    options.find((item) => item.id === selectedVoice)?.name ??
    selectedVoice ??
    (synthesis === "openai" ? "alloy" : "Choose a voice");

  const refreshVoices = async () => {
    setLoading(true);
    setError(null);
    const result = await listVoices({ environmentId, input: { provider: synthesis } });
    setLoading(false);
    if (result._tag === "Failure") {
      setError(commandError(result));
      return;
    }
    setVoices({ provider: synthesis, items: result.value.voices });
  };

  return (
    <>
      <SettingsRow
        {...searchableSetting("voice-transcription-service")}
        description="Turns what you say into a chat message for the bot."
        control={
          <Select
            value={transcription}
            onValueChange={(value) => {
              const next = TRANSCRIPTION_PROVIDERS.find((candidate) => candidate === value);
              if (next) onChange({ transcriptionProvider: next });
            }}
          >
            <SelectTrigger className="w-full sm:w-52" aria-label="Transcription service">
              <SelectValue>{VOICE_API_PROVIDER_LABELS[transcription]}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {TRANSCRIPTION_PROVIDERS.map((provider) => (
                <SelectItem key={provider} value={provider}>
                  {VOICE_API_PROVIDER_LABELS[provider]}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      <SettingsRow
        {...searchableSetting("voice-synthesis-service")}
        description="Speaks the bot's completed reply."
        control={
          <Select
            value={synthesis}
            onValueChange={(value) => {
              const next = VOICE_API_PROVIDERS.find((candidate) => candidate === value);
              if (next) onChange({ synthesisProvider: next });
            }}
          >
            <SelectTrigger className="w-full sm:w-52" aria-label="Speech service">
              <SelectValue>{VOICE_API_PROVIDER_LABELS[synthesis]}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {VOICE_API_PROVIDERS.map((provider) => (
                <SelectItem key={provider} value={provider}>
                  {VOICE_API_PROVIDER_LABELS[provider]}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      <SettingsRow
        {...searchableSetting("voice-synthesis-voice")}
        description={`Refresh to load the voices your ${VOICE_API_PROVIDER_LABELS[synthesis]} account offers.`}
        status={error ? <span className="text-destructive">{error}</span> : null}
        control={
          <div className="flex items-center gap-1.5">
            <Select
              value={selectedVoice ?? ""}
              disabled={options.length === 0}
              onValueChange={(value) => {
                if (!value) return;
                onChange({ synthesisVoices: { ...voice.synthesisVoices, [synthesis]: value } });
              }}
            >
              <SelectTrigger className="w-full sm:w-44" aria-label="Speech voice">
                <SelectValue>{selectedName}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {options.map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.name || item.id}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            <Button
              size="xs"
              variant="outline"
              disabled={loading}
              onClick={() => void refreshVoices()}
              aria-label="Refresh speech voices"
            >
              {loading ? <LoaderIcon className="size-3 animate-spin" /> : null}
              Refresh
            </Button>
          </div>
        }
      />
    </>
  );
}

/** Per-service API keys stored on the environment server. Keys are never read back. */
export function VoiceApiConnectionsSection({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const providersQuery = useEnvironmentQuery(
    serverEnvironment.voiceProviders({ environmentId, input: {} }),
  );
  const connect = useAtomCommand(serverEnvironment.connectVoiceProvider, { reportFailure: false });
  const disconnect = useAtomCommand(serverEnvironment.disconnectVoiceProvider, {
    reportFailure: false,
  });
  const test = useAtomCommand(serverEnvironment.testVoiceProvider, { reportFailure: false });
  const [provider, setProvider] = useState<VoiceApiProvider>("openai");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState<"connect" | "test" | "disconnect" | null>(null);
  const [message, setMessage] = useState<{ readonly error: boolean; readonly text: string } | null>(
    null,
  );
  const connected = useMemo(
    () =>
      new Map(providersQuery.data?.providers.map((status) => [status.provider, status.connected])),
    [providersQuery.data],
  );
  const isConnected = connected.get(provider) === true;
  const label = VOICE_API_PROVIDER_LABELS[provider];

  const run = async (
    action: "connect" | "test" | "disconnect",
    execute: () => Promise<AtomCommandResult<unknown, unknown>>,
    success: string,
  ) => {
    setBusy(action);
    setMessage(null);
    const result = await execute();
    setBusy(null);
    setMessage(
      result._tag === "Failure"
        ? { error: true, text: commandError(result) }
        : { error: false, text: success },
    );
    if (action !== "test") providersQuery.refresh();
    return result._tag !== "Failure";
  };

  const saveKey = async () => {
    const key = apiKey.trim();
    if (!key) return;
    const saved = await run(
      "connect",
      () => connect({ environmentId, input: { provider, apiKey: key } }),
      `${label} is connected.`,
    );
    if (saved) setApiKey("");
  };

  const removeKey = async () => {
    const confirmed =
      (await requestConfirmDialog(
        `Disconnect ${label}? Voice settings that use it stop working until you connect a key again.`,
        { variant: "destructive" },
      )) ?? false;
    if (!confirmed) return;
    await run(
      "disconnect",
      () => disconnect({ environmentId, input: { provider } }),
      `${label} is disconnected.`,
    );
  };

  return (
    <SettingsSection title="API connections">
      <SettingsRow
        {...searchableSetting("voice-api-connections")}
        description="API services bill your account with that service, separately from any subscription. Keys stay on this environment's server."
        status={
          providersQuery.error ? (
            <span className="text-destructive">
              Could not load voice services: {providersQuery.error}
            </span>
          ) : null
        }
        control={
          <Select
            value={provider}
            onValueChange={(value) => {
              const next = VOICE_API_PROVIDERS.find((candidate) => candidate === value);
              if (!next) return;
              setProvider(next);
              setApiKey("");
              setMessage(null);
            }}
          >
            <SelectTrigger className="w-full sm:w-52" aria-label="Voice API service">
              <SelectValue>{label}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {VOICE_API_PROVIDERS.map((candidate) => (
                <SelectItem key={candidate} value={candidate}>
                  {VOICE_API_PROVIDER_LABELS[candidate]}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      <form
        className="space-y-3 px-3 pb-3 sm:px-4"
        onSubmit={(event) => {
          event.preventDefault();
          void saveKey();
        }}
      >
        <div className="flex items-center gap-2 text-sm">
          {label}
          <Badge variant={isConnected ? "success" : "outline"} className="h-4 px-1.5 text-[10px]">
            {providersQuery.data ? (isConnected ? "Connected" : "Not connected") : "Loading"}
          </Badge>
        </div>
        <label className="block space-y-1 text-sm">
          <span>API key</span>
          <Input
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={apiKey}
            disabled={busy !== null}
            placeholder={isConnected ? "Paste a new key to replace it" : "Paste an API key"}
            onChange={(event) => setApiKey(event.currentTarget.value)}
            aria-label={`${label} API key`}
          />
        </label>
        <div className="flex flex-wrap gap-1.5">
          <Button size="xs" type="submit" disabled={busy !== null || apiKey.trim().length === 0}>
            {busy === "connect" ? <LoaderIcon className="size-3 animate-spin" /> : null}
            {isConnected ? "Replace key" : "Connect"}
          </Button>
          <Button
            size="xs"
            variant="outline"
            disabled={busy !== null || !isConnected}
            onClick={() =>
              void run(
                "test",
                () => test({ environmentId, input: { provider } }),
                `${label} accepted the key.`,
              )
            }
          >
            {busy === "test" ? <LoaderIcon className="size-3 animate-spin" /> : null}
            Test API access
          </Button>
          <Button
            size="xs"
            variant="ghost-muted"
            disabled={busy !== null || !isConnected}
            onClick={() => void removeKey()}
          >
            Disconnect
          </Button>
        </div>
        {message ? (
          <p
            role={message.error ? "alert" : "status"}
            className={message.error ? "text-xs text-destructive" : "text-xs text-muted-foreground"}
          >
            {message.text}
          </p>
        ) : null}
      </form>
    </SettingsSection>
  );
}
