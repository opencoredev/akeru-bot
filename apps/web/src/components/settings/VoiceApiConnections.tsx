import { VOICE_API_PROVIDERS, type EnvironmentId, type VoiceApiProvider } from "@akeru/contracts";
import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@akeru/client-runtime/state/runtime";
import { LoaderIcon } from "lucide-react";
import { useState } from "react";
import { requestConfirmDialog } from "../../confirmDialog";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useI18n } from "../../i18n";
import {
  VOICE_API_NAMES,
  VOICE_API_PROVIDER_LABELS,
  nextVoiceKeyRejected,
  voiceKeyWasRejected,
  voiceCapabilityLabel,
} from "./voiceSettings.logic";

export function commandError(result: AtomCommandResult<unknown, unknown>): string {
  if (result._tag !== "Failure") return "The request failed.";
  const error = squashAtomCommandFailure(result);

  return error instanceof Error ? error.message : "The request failed.";
}

type ProviderMessage = { readonly tone: "error" | "ok"; readonly text: string };

export function VoiceApiConnectionsSection({
  environmentId,
  connected,
  serverRejected,
  loadError,
  onChanged,
  onKeySaved,
}: {
  readonly environmentId: EnvironmentId;
  readonly connected: ReadonlyArray<VoiceApiProvider> | null;
  readonly serverRejected: Partial<Record<VoiceApiProvider, boolean>>;
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

  // This client's latest verdicts, shown until the next provider status arrives.
  // Servers that do not report a verdict keep using them.
  const [local, setLocal] = useState<{
    readonly basis: Partial<Record<VoiceApiProvider, boolean>>;
    readonly rejected: Partial<Record<VoiceApiProvider, boolean>>;
  }>({ basis: serverRejected, rejected: {} });

  const rejectedFor = (provider: VoiceApiProvider) =>
    (local.basis === serverRejected ? local.rejected[provider] : undefined) ??
    serverRejected[provider] ??
    local.rejected[provider] ??
    false;

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
    const failure = result._tag === "Failure" ? squashAtomCommandFailure(result) : null;
    const keyRejected = failure !== null && voiceKeyWasRejected(failure);
    const nextRejected = nextVoiceKeyRejected(rejectedFor(provider), failure);
    setLocal((current) => ({
      basis: serverRejected,
      rejected: { ...current.rejected, [provider]: nextRejected },
    }));
    setMessages((current) => ({
      ...current,
      [provider]: ok
        ? { tone: "ok", text: success }
        : {
            tone: "error",
            // The server's wording points to Settings for call errors; here the user is already there.
            text: keyRejected
              ? t("The voice provider rejected the API key. Replace the key and test it again.")
              : commandError(result),
          },
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
          keyRejected={rejectedFor(provider)}
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
  keyRejected = false,
  busyAction,
  disabled,
  message,
  onConnect,
  onTest,
  onDisconnect,
}: {
  readonly provider: VoiceApiProvider;
  readonly connected: boolean | undefined;
  /** The last Test found the saved key invalid. */
  readonly keyRejected?: boolean;
  readonly busyAction: string | null;
  readonly disabled: boolean;
  readonly message: ProviderMessage | null;
  readonly onConnect: (apiKey: string) => Promise<boolean>;
  readonly onTest: () => void;
  readonly onDisconnect: () => void;
}) {
  const { t } = useI18n();
  const label = VOICE_API_PROVIDER_LABELS[provider];
  const keyLabel = t("{api} key", { api: VOICE_API_NAMES[provider] });
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
            <Badge
              variant={connected ? (keyRejected ? "error" : "success") : "outline"}
              presentation="connection-kind"
            >
              {connected ? (keyRejected ? t("Key rejected") : t("Key saved")) : t("Not connected")}
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
                placeholder={keyLabel}
                aria-label={keyLabel}
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
