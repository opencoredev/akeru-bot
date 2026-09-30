import { CHANNEL_PROVIDERS, type ChannelProvider } from "@akeru/contracts";
import { createFileRoute, redirect } from "@tanstack/react-router";

import { ChannelDetailPage } from "../components/settings/ChannelDetailPage";

function isChannelProvider(value: string): value is ChannelProvider {
  return (CHANNEL_PROVIDERS as ReadonlyArray<string>).includes(value);
}

export const Route = createFileRoute("/settings/channels/$channel")({
  beforeLoad: ({ params }) => {
    if (isChannelProvider(params.channel)) return;
    throw redirect({ to: "/settings/$section", params: { section: "channels" }, replace: true });
  },
  component: ChannelSettingsRoute,
});

function ChannelSettingsRoute() {
  const { channel } = Route.useParams();
  if (!isChannelProvider(channel)) return null;
  return <ChannelDetailPage key={channel} provider={channel} />;
}
