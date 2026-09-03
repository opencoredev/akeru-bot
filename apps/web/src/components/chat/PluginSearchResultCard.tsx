import type { AkeruPluginRecommendation, AkeruPluginSearchResult } from "@t3tools/contracts";
import { CheckCircle2Icon, WrenchIcon } from "lucide-react";
import { memo } from "react";

import { loadDirectoryCatalog } from "../../../../../plugins";
import { openPlugins } from "../../pluginsDialogStore";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";

const DIRECTORY_PLUGINS = new Map(loadDirectoryCatalog().map((plugin) => [plugin.id, plugin]));

function recommendationActionLabel(
  recommendation: AkeruPluginRecommendation,
  composioStatus: AkeruPluginSearchResult["sources"]["composio"],
): string {
  if (recommendation.action === "install") return "Install";
  if (
    recommendation.action === "connect" &&
    recommendationUsesComposio(recommendation) &&
    composioStatus === "setup-required"
  ) {
    return "Set up";
  }
  if (recommendation.action === "connect") return "Connect";
  if (recommendation.action === "unavailable") return "Unavailable";
  return "Manage";
}

function recommendationLogo(recommendation: AkeruPluginRecommendation): string | undefined {
  if (recommendation.logoUrl) return recommendation.logoUrl;
  if (recommendation.source === "composio") {
    const slug = recommendation.id.replace(/^composio:/, "");
    return `https://logos.composio.dev/api/${encodeURIComponent(slug)}`;
  }
  return recommendation.source === "directory"
    ? DIRECTORY_PLUGINS.get(recommendation.id)?.logo.src
    : undefined;
}

function recommendationProviderLabel(recommendation: AkeruPluginRecommendation): string {
  if (recommendation.source === "composio") return "Composio";
  const plugin = DIRECTORY_PLUGINS.get(recommendation.id);
  return plugin?.connection.type === "brokered" ? plugin.connection.broker.name : "Akeru";
}

function recommendationUsesComposio(recommendation: AkeruPluginRecommendation): boolean {
  return recommendationProviderLabel(recommendation) === "Composio";
}

export const PluginSearchResultCard = memo(function PluginSearchResultCard({
  result,
  className,
}: {
  readonly result: AkeruPluginSearchResult;
  readonly className?: string;
}) {
  const recommendation = result.recommendations[0];
  if (!recommendation) return null;

  const logo = recommendationLogo(recommendation);
  const action = recommendationActionLabel(recommendation, result.sources.composio);
  const connected = recommendation.action === "open";
  const setupRequired =
    recommendation.action === "connect" &&
    recommendationUsesComposio(recommendation) &&
    result.sources.composio === "setup-required";
  return (
    <section
      aria-label={`${recommendation.name} plugin`}
      className={cn(
        "flex max-w-xl min-w-0 items-center gap-3 rounded-xl border border-border/70 bg-card/55 px-3 py-2.5",
        className,
      )}
    >
      <span className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted p-1.5">
        {logo ? (
          <img alt="" className="size-full object-contain" src={logo} />
        ) : (
          <WrenchIcon aria-hidden="true" className="size-4 text-muted-foreground" />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="truncate text-sm font-medium">{recommendation.name}</p>
          <span className="shrink-0 text-[11px] text-muted-foreground">
            {recommendationProviderLabel(recommendation)}
          </span>
        </div>
        {connected ? (
          <p className="flex items-center gap-1 text-xs text-emerald-500">
            <CheckCircle2Icon aria-hidden="true" className="size-3" />
            Connected
          </p>
        ) : (
          <p className="truncate text-xs text-muted-foreground">
            {setupRequired ? "Set up Composio first" : recommendation.description}
          </p>
        )}
      </div>
      <Button
        aria-label={`${action} ${recommendation.name}`}
        className="h-8 rounded-full px-3.5 text-xs"
        disabled={recommendation.action === "unavailable"}
        size="sm"
        variant="secondary"
        onClick={() => openPlugins(recommendation.name)}
      >
        {action}
      </Button>
    </section>
  );
});
