import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ServerProvider } from "@t3tools/contracts";

import { useSettingsEnvironmentId } from "../../settingsDialogStore";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { PROVIDER_CATALOG, type ProviderCatalogEntry } from "./providerCatalog";
import { ProviderInstancesSection } from "./ProviderInstancesSection";
import { ProviderAccountSection, useSubscriptionStatuses } from "./ProvidersPanel";
import {
  accountConnectionState,
  type ProviderConnectionState,
  runtimeConnectionState,
} from "./providerStatus";
import { SettingsDetailHeader, SettingsLinkRow, SettingsMessageRow } from "./settingsDetailLayout";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useI18n } from "../../i18n";
import { subscriptionProviderTargetId } from "./subscriptionProviders";

/**
 * The live snapshot for a catalog entry's default instance. A provider can
 * have several instances; the default slot speaks for the provider as a whole.
 */
export function defaultServerProvider(
  providers: ReadonlyArray<ServerProvider>,
  entry: ProviderCatalogEntry,
): ServerProvider | undefined {
  return (
    providers.find((provider) => provider.driver === entry.drivers[0] && provider.enabled) ??
    providers.find((provider) => provider.driver === entry.drivers[0])
  );
}

/** Headline state of a provider row or page: its account when it has one, else its runtime. */
export function useProviderConnectionStates(
  environmentId: EnvironmentId,
  entries: ReadonlyArray<ProviderCatalogEntry>,
): {
  readonly states: ReadonlyMap<string, ProviderConnectionState>;
  readonly plans: ReadonlyMap<string, string>;
  readonly error: string | null;
} {
  const { t, translate } = useI18n();
  const { statusQuery, statusByProvider } = useSubscriptionStatuses(environmentId);
  const serverProviders =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const states = new Map<string, ProviderConnectionState>();
  const plans = new Map<string, string>();
  for (const entry of entries) {
    if (entry.account) {
      const status = statusByProvider.get(entry.account.id);
      states.set(
        entry.slug,
        translateConnectionState(accountConnectionState(status, statusQuery.isPending), translate),
      );
      plans.set(
        entry.slug,
        status?.connected && status.authMode === "api-key"
          ? `${t("API key")}${status.baseUrl ? ` · ${status.baseUrl}` : ""}`
          : translate(entry.planHint),
      );
    } else {
      states.set(
        entry.slug,
        translateConnectionState(
          runtimeConnectionState(defaultServerProvider(serverProviders, entry)),
          translate,
        ),
      );
      plans.set(entry.slug, translate(entry.planHint));
    }
  }
  return { states, plans, error: statusQuery.error };
}

/** Connection labels are fixed English catalog keys; detail can be server text and stays as sent. */
function translateConnectionState(
  state: ProviderConnectionState,
  translate: (message: string) => string,
): ProviderConnectionState {
  return { ...state, label: translate(state.label) };
}

function useUnavailableState(): ProviderConnectionState {
  const { t } = useI18n();
  return { tone: "neutral", label: t("Unavailable"), detail: null };
}

export function ProviderDetailPage({ entry }: { readonly entry: ProviderCatalogEntry }) {
  const { t, translate } = useI18n();
  const unavailable = useUnavailableState();
  const environmentId = useSettingsEnvironmentId();
  if (environmentId === null) {
    return (
      <SettingsPageContainer className="gap-10">
        <ProviderHeader entry={entry} state={unavailable} plan={translate(entry.planHint)} />
        <SettingsSection title={t("Account")}>
          <SettingsMessageRow>
            {t("Connect to an environment to set up {provider}.", { provider: entry.label })}
          </SettingsMessageRow>
        </SettingsSection>
      </SettingsPageContainer>
    );
  }
  return (
    <ConnectedProviderDetail key={environmentId} environmentId={environmentId} entry={entry} />
  );
}

function ProviderHeader({
  entry,
  state,
  plan,
}: {
  readonly entry: ProviderCatalogEntry;
  readonly state: ProviderConnectionState;
  readonly plan: string;
}) {
  const { t } = useI18n();
  return (
    <SettingsDetailHeader
      back={{ section: "providers", label: t("Providers") }}
      icon={entry.icon}
      title={entry.label}
      tone={state.tone}
      statusLabel={state.label}
      description={plan}
    />
  );
}

function ConnectedProviderDetail({
  environmentId,
  entry,
}: {
  readonly environmentId: EnvironmentId;
  readonly entry: ProviderCatalogEntry;
}) {
  const { translate } = useI18n();
  const unavailable = useUnavailableState();
  const { states, plans } = useProviderConnectionStates(environmentId, [entry]);
  return (
    <SettingsPageContainer className="gap-10">
      <ProviderHeader
        entry={entry}
        state={states.get(entry.slug) ?? unavailable}
        plan={plans.get(entry.slug) ?? translate(entry.planHint)}
      />
      {entry.account ? (
        <ProviderAccountSection environmentId={environmentId} definition={entry.account} />
      ) : null}
      <ProviderInstancesSection
        environmentId={environmentId}
        drivers={entry.drivers}
        {...(entry.account ? { account: entry.account } : {})}
        providerLabel={entry.label}
      />
    </SettingsPageContainer>
  );
}

/** The Providers overview list: one row per provider, each opening its subpage. */
export function ProvidersListSection() {
  const { t } = useI18n();
  const environmentId = useSettingsEnvironmentId();
  if (environmentId === null) {
    return (
      <SettingsSection {...searchableSetting("providers", t)}>
        <SettingsMessageRow>
          {t("Connect to an environment to set up providers.")}
        </SettingsMessageRow>
      </SettingsSection>
    );
  }
  return <ConnectedProvidersList key={environmentId} environmentId={environmentId} />;
}

function ConnectedProvidersList({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const { t, translate } = useI18n();
  const unavailable = useUnavailableState();
  const { states, plans, error } = useProviderConnectionStates(environmentId, PROVIDER_CATALOG);
  return (
    <>
      <SettingsSection {...searchableSetting("providers", t)}>
        {PROVIDER_CATALOG.map((entry) => {
          const state = states.get(entry.slug) ?? unavailable;
          return (
            <SettingsLinkRow
              key={entry.slug}
              {...(entry.account ? { id: subscriptionProviderTargetId(entry.account.id) } : {})}
              link={{ to: "/settings/providers/$providerId", params: { providerId: entry.slug } }}
              icon={entry.icon}
              title={entry.label}
              description={plans.get(entry.slug) ?? translate(entry.planHint)}
              tone={state.tone}
              statusLabel={state.label}
            />
          );
        })}
      </SettingsSection>
      {error ? (
        <p role="alert" className="-mt-5 px-3 text-[13px] text-destructive sm:px-4">
          {t("Could not load account status.")} {error}
        </p>
      ) : null}
    </>
  );
}
