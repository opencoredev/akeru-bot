import {
  ArrowDownIcon,
  ArrowUpIcon,
  EllipsisIcon,
  ExternalLinkIcon,
  KeyRoundIcon,
  LoaderIcon,
  LogOutIcon,
  PlusIcon,
  RefreshCwIcon,
} from "lucide-react";
import { type ReactNode } from "react";
import type { EnvironmentId, SubscriptionProviderStatus } from "@akeru/contracts";
import type { MessageKey } from "@akeru/client-runtime/i18n";
import { providerSupportsBaseUrl, providerUsesApiKey } from "@akeru/client-runtime/provider-auth";

import { useI18n } from "../../i18n";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { ActiveLoginPanel, BusyIcon, ProviderApiKeyForm } from "./ProviderAccountControls";
import { SettingsMessageRow } from "./settingsDetailLayout";
import { SettingsSection } from "./settingsLayout";
import { linkedAccountTitle, type SubscriptionProviderDefinition } from "./subscriptionProviders";
import { useSubscriptionAccounts } from "./useSubscriptionAccounts";

/** True while a linked account sits out a usage limit. */
function accountResting(status: SubscriptionProviderStatus, now: number): boolean {
  return status.nextRetryAt !== undefined && Date.parse(status.nextRetryAt) > now;
}

/** A reset time: the clock time when it is within the day, else the date. */
function formatResetTime(iso: string, locale: string, now: number): string {
  const at = new Date(iso);
  const sameDay = at.getTime() - now < 20 * 60 * 60 * 1000;

  return new Intl.DateTimeFormat(
    locale,
    sameDay ? { hour: "numeric", minute: "2-digit" } : { month: "short", day: "numeric" },
  ).format(at);
}

type AccountState =
  | { readonly kind: "checking" }
  | { readonly kind: "resting"; readonly time: string }
  | { readonly kind: "signed-out"; readonly label: MessageKey }
  | { readonly kind: "unreachable" }
  | { readonly kind: "in-use" }
  | { readonly kind: "ready" };

function linkedAccountState(
  status: SubscriptionProviderStatus,
  busy: boolean,
  locale: string,
  now: number,
): AccountState {
  if (busy || status.healthChecking === true) return { kind: "checking" };

  if (status.nextRetryAt && accountResting(status, now)) {
    return { kind: "resting", time: formatResetTime(status.nextRetryAt, locale, now) };
  }

  if (status.health === "expired") return { kind: "signed-out", label: "Login expired" };

  if (status.health === "revoked") {
    return {
      kind: "signed-out",
      label: providerUsesApiKey(status) ? "Key rejected" : "Signed out",
    };
  }

  if (status.health === "failed" || status.health === "failed-first-request") {
    return { kind: "unreachable" };
  }

  return status.active ? { kind: "in-use" } : { kind: "ready" };
}

/**
 * One linked account in priority order: its place in line, its tier, what it
 * is doing now, and the one action that fixes it when it is not working.
 */
function LinkedAccountCard({
  definition,
  status,
  position,
  count,
  busy,
  disabled,
  onMove,
  onReconnect,
  onRetry,
  onRemove,
}: {
  readonly definition: SubscriptionProviderDefinition;
  readonly status: SubscriptionProviderStatus;
  readonly position: number;
  readonly count: number;
  readonly busy: boolean;
  readonly disabled: boolean;
  readonly onMove: (offset: -1 | 1) => void;
  readonly onReconnect: () => void;
  readonly onRetry: () => void;
  readonly onRemove: () => void;
}) {
  const { t, locale } = useI18n();
  const usesKey = providerUsesApiKey(status);
  const title = linkedAccountTitle(definition, status, t);
  const state = linkedAccountState(status, busy, locale, Date.now());
  const reconnectLabel = usesKey ? t("Replace key") : t("Sign in again");

  const role =
    count > 1
      ? position === 0
        ? t("Main account")
        : t("Backup {number}", { number: String(position) })
      : null;

  let stateText: ReactNode;

  switch (state.kind) {
    case "checking":
      stateText = (
        <span className="inline-flex items-center gap-1 text-muted-foreground">
          <LoaderIcon className="size-3 animate-spin" />
          {t("Checking sign-in")}
        </span>
      );
      break;
    case "resting":
      stateText = (
        <span className="text-warning-foreground">
          {t("Usage limit reached, back at {time}", { time: state.time })}
        </span>
      );
      break;
    case "signed-out":
      stateText = <span className="text-destructive-foreground">{t(state.label)}</span>;
      break;
    case "unreachable":
      stateText = (
        <span className="text-destructive-foreground">
          {t("Can't reach {provider}", { provider: definition.label })}
        </span>
      );
      break;
    case "in-use":
      stateText = <span className="text-success-foreground">{t("In use")}</span>;
      break;
    case "ready":
      stateText = <span className="text-muted-foreground">{t("Ready")}</span>;
      break;
  }

  let fix: ReactNode = null;

  if (state.kind === "signed-out") {
    fix = (
      <Button size="xs" variant="outline" disabled={disabled} onClick={onReconnect}>
        {reconnectLabel}
      </Button>
    );
  } else if (state.kind === "unreachable") {
    fix = (
      <Button size="xs" variant="outline" disabled={disabled} onClick={onRetry}>
        <RefreshCwIcon className="size-3.5" />
        {t("Try again")}
      </Button>
    );
  }

  return (
    <div
      data-settings-row=""
      data-account-id={status.accountId}
      className="flex items-center gap-3 rounded-xl px-3 py-3 sm:px-4"
    >
      <span
        aria-hidden
        className={cn(
          "flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-medium tabular-nums",
          state.kind === "in-use"
            ? "bg-foreground text-background"
            : "bg-muted text-muted-foreground",
        )}
      >
        {position + 1}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-foreground">{title}</p>
        <p className="truncate text-xs">
          {role ? <span className="text-muted-foreground">{role} · </span> : null}
          {stateText}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        {fix ? <span className="mr-1.5">{fix}</span> : null}
        {count > 1 ? (
          <>
            <Button
              size="icon-xs"
              variant="ghost-muted"
              aria-label={t("Move {account} up", { account: title })}
              disabled={disabled || position === 0}
              onClick={() => onMove(-1)}
            >
              <ArrowUpIcon className="size-3.5" />
            </Button>
            <Button
              size="icon-xs"
              variant="ghost-muted"
              aria-label={t("Move {account} down", { account: title })}
              disabled={disabled || position === count - 1}
              onClick={() => onMove(1)}
            >
              <ArrowDownIcon className="size-3.5" />
            </Button>
          </>
        ) : null}
        <Menu>
          <MenuTrigger
            render={
              <Button
                size="icon-xs"
                variant="ghost-muted"
                aria-label={t("Actions for {name}", { name: title })}
                disabled={disabled}
              />
            }
          >
            <EllipsisIcon className="size-3.5" />
          </MenuTrigger>
          <MenuPopup align="end" className="min-w-40">
            <MenuItem onClick={onReconnect}>
              <KeyRoundIcon />
              {reconnectLabel}
            </MenuItem>
            <MenuSeparator />
            <MenuItem variant="destructive" onClick={onRemove}>
              <LogOutIcon />
              {t("Remove")}
            </MenuItem>
          </MenuPopup>
        </Menu>
      </div>
    </div>
  );
}

/**
 * Accounts section of a provider subpage. Lists every linked account in the
 * order bots use them: the first ready one serves requests, and one that hits
 * a usage limit sits out while the next takes over. Hidden until an account
 * is linked, since the Account section above handles the first sign-in.
 */
export function ProviderAccountsSection({
  environmentId,
  definition,
}: {
  readonly environmentId: EnvironmentId | null;
  readonly definition: SubscriptionProviderDefinition;
}) {
  const { t } = useI18n();
  const accounts = useSubscriptionAccounts(environmentId);

  const linked = (accounts.statusQuery.data?.linkedAccounts ?? []).filter(
    (status) => status.provider === definition.id && status.accountId !== undefined,
  );

  const keyOnly = definition.id === "opencode-go";
  const locked = accounts.busyProvider !== null;
  const adding = accounts.keyProvider !== null || accounts.activeLogin !== null;

  if (environmentId === null || (linked.length === 0 && !adding)) return null;

  const move = (index: number, offset: -1 | 1) => {
    const ids = linked.map((entry) => entry.accountId!);
    const [moved] = ids.splice(index, 1);
    ids.splice(index + offset, 0, moved!);
    void accounts.setAccountOrder(definition.id, ids);
  };

  const addButton = keyOnly ? (
    <Button
      size="xs"
      variant="outline"
      disabled={locked || adding}
      onClick={() => accounts.openApiKey(definition, { addAccount: true })}
    >
      <PlusIcon className="size-3.5" />
      {t("Add account")}
    </Button>
  ) : (
    <Menu>
      <MenuTrigger render={<Button size="xs" variant="outline" disabled={locked || adding} />}>
        <BusyIcon
          busy={accounts.busyProvider === definition.id && accounts.busyAccount === null}
          idle={<PlusIcon className="size-3.5" />}
        />
        {t("Add account")}
      </MenuTrigger>
      <MenuPopup align="end" className="min-w-44">
        <MenuItem onClick={() => void accounts.connect(definition, { addAccount: true })}>
          <ExternalLinkIcon />
          {t("Sign in with {provider}", { provider: definition.label })}
        </MenuItem>
        <MenuItem onClick={() => accounts.openApiKey(definition, { addAccount: true })}>
          <KeyRoundIcon />
          {t("Use an API key")}
        </MenuItem>
      </MenuPopup>
    </Menu>
  );

  let body: ReactNode;

  if (accounts.keyProvider) {
    body = (
      <div data-settings-row="" className="rounded-xl pt-3">
        <h3 className="px-3 pb-3 text-sm font-medium text-foreground sm:px-4">
          {accounts.keyTarget.accountId ? t("Replace API key") : t("Add API key")}
        </h3>
        <ProviderApiKeyForm
          supportsBaseUrl={providerSupportsBaseUrl(accounts.keyProvider.id)}
          apiKey={accounts.pastedCode}
          baseUrl={accounts.baseUrl}
          busy={accounts.completing}
          error={accounts.error}
          onKeyChange={accounts.setPastedCode}
          onBaseUrlChange={accounts.setBaseUrl}
          onSave={() => void accounts.saveApiKey()}
          onCancel={accounts.closeApiKey}
        />
      </div>
    );
  } else if (accounts.activeLogin) {
    body = (
      <ActiveLoginPanel
        login={accounts.activeLogin}
        pastedCode={accounts.pastedCode}
        onPastedCodeChange={accounts.setPastedCode}
        onComplete={() => void accounts.complete()}
        onCancel={() => void accounts.cancelLogin()}
        completing={accounts.completing}
      />
    );
  } else {
    body = (
      <>
        {accounts.error ? (
          <SettingsMessageRow tone="error">{accounts.error}</SettingsMessageRow>
        ) : null}
        {linked.map((entry, index) => (
          <LinkedAccountCard
            key={entry.accountId}
            definition={definition}
            status={entry}
            position={index}
            count={linked.length}
            busy={accounts.busyAccount === entry.accountId}
            disabled={locked}
            onMove={(offset) => move(index, offset)}
            onReconnect={() =>
              providerUsesApiKey(entry)
                ? accounts.openApiKey(definition, { accountId: entry.accountId! })
                : void accounts.connect(definition, { accountId: entry.accountId! })
            }
            onRetry={() => void accounts.testHealth(definition.id, entry.accountId)}
            onRemove={() => void accounts.disconnect(definition.id, entry.accountId)}
          />
        ))}
      </>
    );
  }

  return (
    <SettingsSection id="provider-accounts" title={t("Accounts")} headerAction={addButton}>
      {body}
    </SettingsSection>
  );
}
