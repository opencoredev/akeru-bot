import { ExternalLinkIcon, LoaderIcon, LogOutIcon, RefreshCwIcon } from "lucide-react";
import { type ReactNode } from "react";
import type { SubscriptionProviderStatus } from "@akeru/contracts";
import { providerUsesApiKey } from "@akeru/client-runtime/provider-auth";
import { useI18n } from "../../i18n";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { ProviderAccessDetails } from "./ProviderAccessDetails";
import { accountConnectionState } from "./providerStatus";
import { SignInCodeCopy } from "./SignInCodeCopy";
import { SettingsRow } from "./settingsLayout";
import type { SubscriptionProviderDefinition } from "./subscriptionProviders";
import type { ActiveLogin } from "./useSubscriptionAccounts";

export type Translate = ReturnType<typeof useI18n>["t"];

function disconnectDescription(
  status: SubscriptionProviderStatus | undefined,
  t: Translate,
  locale: string,
): string {
  const bots = status?.dependentBots.map((bot) => bot.name) ?? [];

  if (bots.length === 0) return t("Remove the saved credentials from this environment.");

  const shown =
    bots.length > 3 ? [...bots.slice(0, 3), t("{count} more", { count: bots.length - 3 })] : bots;

  const names = new Intl.ListFormat(locale, { type: "conjunction" }).format(shown);

  return bots.length === 1
    ? t("{names} uses this account.", { names })
    : t("{names} use this account.", { names });
}

function BusyIcon({ busy, idle }: { readonly busy: boolean; readonly idle?: ReactNode }) {
  if (busy) return <LoaderIcon className="size-3.5 animate-spin" />;

  return idle ?? null;
}

/**
 * The rows of a provider's Account section: how the environment signs in to
 * the provider, and the way back out. Each row has one primary action.
 */
export function ProviderAccountRows({
  definition,
  status,
  busy,
  disabled = false,
  onConnect,
  onDisconnect,
  onTest,
  onApiKey,
  models,
}: {
  readonly definition: SubscriptionProviderDefinition;
  readonly status: SubscriptionProviderStatus | undefined;
  /** Model names this environment serves for the provider, for the access guide. */
  readonly models?: ReadonlyArray<string>;
  readonly busy: boolean;
  readonly disabled?: boolean;
  readonly onConnect: () => void;
  readonly onDisconnect: () => void;
  readonly onTest: () => void;
  readonly onApiKey: () => void;
}) {
  const { t, locale } = useI18n();
  const connected = status?.connected === true;
  const usesKey = connected && providerUsesApiKey(status);
  const keyOnly = definition.id === "opencode-go";
  const locked = busy || disabled;
  const attention = accountConnectionState(status, false);
  const problem = attention.tone === "attention" ? attention.detail : null;

  return (
    <>
      {connected ? (
        <SettingsRow
          title={t("Connected account")}
          description={
            status.accountLabel ??
            (usesKey ? t("API key saved on this environment") : t("Account identity unavailable"))
          }
        />
      ) : null}
      {keyOnly ? null : (
        <SettingsRow
          title={t("Subscription")}
          description={t(definition.subscription)}
          status={
            problem && !usesKey ? <span className="text-destructive">{t(problem)}</span> : undefined
          }
          control={
            !connected ? (
              <Button size="xs" disabled={locked} onClick={onConnect}>
                <BusyIcon busy={busy} />
                {t("Connect")}
              </Button>
            ) : usesKey ? (
              <Button size="xs" variant="outline" disabled={locked} onClick={onConnect}>
                {t("Use OAuth")}
              </Button>
            ) : (
              <>
                <Button size="xs" variant="ghost-muted" disabled={locked} onClick={onConnect}>
                  {t("Reconnect")}
                </Button>
                <Button size="xs" variant="outline" disabled={locked} onClick={onTest}>
                  <BusyIcon busy={busy} idle={<RefreshCwIcon className="size-3.5" />} />
                  {t("Check")}
                </Button>
              </>
            )
          }
        />
      )}
      <SettingsRow
        title={t("API key")}
        description={
          usesKey
            ? status?.baseUrl
              ? t("Saved · {baseUrl}", { baseUrl: status.baseUrl })
              : t("Saved")
            : keyOnly
              ? t(definition.description)
              : t("Pay per request instead of using the subscription.")
        }
        status={
          problem && usesKey ? <span className="text-destructive">{t(problem)}</span> : undefined
        }
        control={
          usesKey ? (
            <>
              <Button size="xs" variant="ghost-muted" disabled={locked} onClick={onApiKey}>
                {t("Replace key")}
              </Button>
              <Button size="xs" variant="outline" disabled={locked} onClick={onTest}>
                <BusyIcon busy={busy} idle={<RefreshCwIcon className="size-3.5" />} />
                {t("Check key")}
              </Button>
            </>
          ) : (
            <Button
              size="xs"
              variant={keyOnly && !connected ? "default" : "outline"}
              disabled={locked}
              onClick={onApiKey}
            >
              {t("Add key")}
            </Button>
          )
        }
      />
      <SettingsRow
        title={t("Access")}
        description={
          <ProviderAccessDetails
            provider={definition.id}
            status={status}
            models={models}
            showFailure={false}
          />
        }
      />
      {connected ? (
        <SettingsRow
          title={t("Disconnect")}
          description={disconnectDescription(status, t, locale)}
          control={
            <Button
              size="xs"
              variant="destructive-outline"
              aria-label={t("Disconnect {provider}", { provider: definition.label })}
              disabled={locked}
              onClick={onDisconnect}
            >
              <LogOutIcon className="size-3.5" />
              {t("Disconnect")}
            </Button>
          }
        />
      ) : null}
    </>
  );
}

export function ProviderApiKeyForm({
  supportsBaseUrl = true,
  apiKey,
  baseUrl,
  busy,
  error,
  onKeyChange,
  onBaseUrlChange,
  onSave,
  onCancel,
}: {
  readonly supportsBaseUrl?: boolean;
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly busy: boolean;
  readonly error: string | null;
  readonly onKeyChange: (value: string) => void;
  readonly onBaseUrlChange: (value: string) => void;
  readonly onSave: () => void;
  readonly onCancel: () => void;
}) {
  const { t } = useI18n();

  return (
    <form
      className="space-y-3 px-3 pb-3 sm:px-4"
      onSubmit={(event) => {
        event.preventDefault();
        onSave();
      }}
    >
      <label className="block space-y-1 text-sm">
        <span>{t("API key")}</span>
        <Input
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={apiKey}
          disabled={busy}
          onChange={(event) => onKeyChange(event.currentTarget.value)}
        />
      </label>
      {supportsBaseUrl ? (
        <label className="block space-y-1 text-sm">
          <span>{t("Base URL (optional)")}</span>
          <Input
            type="url"
            autoComplete="off"
            spellCheck={false}
            placeholder={t("Provider default")}
            value={baseUrl}
            disabled={busy}
            onChange={(event) => onBaseUrlChange(event.currentTarget.value)}
          />
        </label>
      ) : null}
      <p className="text-[13px] text-muted-foreground">
        {supportsBaseUrl
          ? t("The environment sends this key to the selected endpoint.")
          : t("Grok uses its default endpoint.")}{" "}
        {t("API billing can be separate from your subscription.")}
      </p>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button type="submit" size="xs" disabled={busy || !apiKey.trim()}>
          {busy ? t("Saving…") : t("Save")}
        </Button>
        <Button type="button" size="xs" variant="ghost-muted" disabled={busy} onClick={onCancel}>
          {t("Cancel")}
        </Button>
      </div>
    </form>
  );
}

export function ActiveLoginPanel({
  login,
  pastedCode,
  onPastedCodeChange,
  onComplete,
  onCancel,
  completing,
}: {
  readonly login: ActiveLogin;
  readonly pastedCode: string;
  readonly onPastedCodeChange: (value: string) => void;
  readonly onComplete: () => void;
  readonly onCancel: () => void;
  readonly completing: boolean;
}) {
  const { t } = useI18n();
  const { flow } = login;
  const isApiKey = flow.provider === "opencode-go";

  return (
    <div data-settings-row="" className="space-y-3 rounded-xl px-3 py-3 sm:px-4">
      <p className="text-[13px] leading-[1.45] text-muted-foreground">
        {flow.userCode
          ? t("Copy this code, then open the sign-in page and enter it.")
          : (flow.instructions ??
            t("Finish signing in to {provider} in the browser.", {
              provider: login.providerLabel,
            }))}
      </p>

      {/* The shared copy control falls back to manual copy on plain-HTTP remote clients. */}
      {flow.userCode ? <SignInCodeCopy code={flow.userCode} className="bg-muted/60" /> : null}

      <Button
        size="xs"
        variant="outline"
        render={<a href={flow.url} target="_blank" rel="noreferrer" />}
      >
        {isApiKey ? t("Open OpenCode") : t("Open sign-in page")}
        <ExternalLinkIcon className="size-3.5" />
      </Button>

      {flow.completion === "paste" ? (
        <div className="flex gap-2">
          <Input
            type={isApiKey ? "password" : "text"}
            autoComplete="off"
            value={pastedCode}
            onChange={(event) => onPastedCodeChange(event.currentTarget.value)}
            placeholder={isApiKey ? t("Paste the API key") : t("Paste the authorization code")}
            aria-label={isApiKey ? t("API key") : t("Authorization code")}
            className="flex-1"
          />
          <Button
            size="xs"
            disabled={pastedCode.trim().length === 0 || completing}
            onClick={onComplete}
          >
            {completing ? <LoaderIcon className="size-3.5 animate-spin" /> : null}
            {t("Connect")}
          </Button>
        </div>
      ) : !login.error ? (
        <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
          <LoaderIcon className="size-3.5 animate-spin" />
          {t("Waiting for approval…")}
        </div>
      ) : null}

      {login.error ? (
        <p role="alert" className="text-[13px] text-destructive">
          {login.error}
        </p>
      ) : null}

      <Button size="xs" variant="ghost-muted" disabled={completing} onClick={onCancel}>
        {t("Cancel")}
      </Button>
    </div>
  );
}
