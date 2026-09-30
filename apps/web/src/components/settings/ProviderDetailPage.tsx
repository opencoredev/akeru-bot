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
  const { statusQuery, statusByProvider } = useSubscriptionStatuses(environmentId);
  const serverProviders =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const states = new Map<string, ProviderConnectionState>();
  const plans = new Map<string, string>();
  for (const entry of entries) {
    if (entry.account) {
      const status = statusByProvider.get(entry.account.id);
      states.set(entry.slug, accountConnectionState(status, statusQuery.isPending));
      plans.set(
        entry.slug,
        status?.connected && status.authMode === "api-key"
          ? `API key${status.baseUrl ? ` · ${status.baseUrl}` : ""}`
          : entry.planHint,
      );
    } else {
      states.set(entry.slug, runtimeConnectionState(defaultServerProvider(serverProviders, entry)));
      plans.set(entry.slug, entry.planHint);
    }
  }
  return { states, plans, error: statusQuery.error };
}

const UNAVAILABLE: ProviderConnectionState = {
  tone: "neutral",
  label: "Unavailable",
  detail: null,
};

export function ProviderDetailPage({ entry }: { readonly entry: ProviderCatalogEntry }) {
  const environmentId = useSettingsEnvironmentId();
  if (environmentId === null) {
    return (
      <SettingsPageContainer className="gap-10">
        <ProviderHeader entry={entry} state={UNAVAILABLE} plan={entry.planHint} />
        <SettingsSection title="Account">
          <SettingsMessageRow>
            Connect to an environment to set up {entry.label}.
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
  return (
    <SettingsDetailHeader
      back={{ section: "providers", label: "Providers" }}
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
  const { states, plans } = useProviderConnectionStates(environmentId, [entry]);
  return (
    <SettingsPageContainer className="gap-10">
      <ProviderHeader
        entry={entry}
        state={states.get(entry.slug) ?? UNAVAILABLE}
        plan={plans.get(entry.slug) ?? entry.planHint}
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
  const environmentId = useSettingsEnvironmentId();
  if (environmentId === null) {
    return (
      <SettingsSection {...searchableSetting("providers")}>
        <SettingsMessageRow>Connect to an environment to set up providers.</SettingsMessageRow>
      </SettingsSection>
    );
  }
  return <ConnectedProvidersList key={environmentId} environmentId={environmentId} />;
}

function ConnectedProvidersList({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const { states, plans, error } = useProviderConnectionStates(environmentId, PROVIDER_CATALOG);
  return (
    <>
      <SettingsSection {...searchableSetting("providers")}>
        {PROVIDER_CATALOG.map((entry) => {
          const state = states.get(entry.slug) ?? UNAVAILABLE;
          return (
            <SettingsLinkRow
              key={entry.slug}
              link={{ to: "/settings/providers/$providerId", params: { providerId: entry.slug } }}
              icon={entry.icon}
              title={entry.label}
              description={plans.get(entry.slug) ?? entry.planHint}
              tone={state.tone}
              statusLabel={state.label}
            />
          );
        })}
      </SettingsSection>
      {error ? (
        <p role="alert" className="-mt-5 px-3 text-[13px] text-destructive sm:px-4">
          Could not load account status. {error}
        </p>
      ) : null}
    </>
  );
}
