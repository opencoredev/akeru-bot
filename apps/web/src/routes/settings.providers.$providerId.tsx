import { createFileRoute, redirect } from "@tanstack/react-router";

import { providerCatalogEntry } from "../components/settings/providerCatalog";
import { ProviderDetailPage } from "../components/settings/ProviderDetailPage";

export const Route = createFileRoute("/settings/providers/$providerId")({
  beforeLoad: ({ params }) => {
    if (providerCatalogEntry(params.providerId)) return;
    throw redirect({ to: "/settings/$section", params: { section: "providers" }, replace: true });
  },
  component: ProviderSettingsRoute,
});

function ProviderSettingsRoute() {
  const { providerId } = Route.useParams();
  const entry = providerCatalogEntry(providerId);
  if (!entry) return null;
  return <ProviderDetailPage key={entry.slug} entry={entry} />;
}
