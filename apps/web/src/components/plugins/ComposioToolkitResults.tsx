import type { ComposioToolkit } from "@akeru/contracts";
import { useI18n } from "../../i18n";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import {
  DirectoryCard,
  DirectorySection,
  LOGO_SIZE_CLASS_NAME,
  LOGO_TILE_CLASS_NAME,
} from "./PluginCatalogCards";

export function ComposioToolkitResults({
  toolkits,
  connectedToolkitIds,
  pendingToolkitId,
  onConnect,
}: {
  readonly toolkits: readonly ComposioToolkit[];
  readonly connectedToolkitIds: ReadonlySet<string>;
  readonly pendingToolkitId: string | null;
  readonly onConnect: (toolkit: ComposioToolkit) => void;
}) {
  const { t, plural } = useI18n();

  if (toolkits.length === 0) return null;

  return (
    <DirectorySection count={toolkits.length} label={t("From Composio")}>
      {toolkits.map((toolkit) => {
        const connected = connectedToolkitIds.has(toolkit.slug);

        return (
          <DirectoryCard
            key={toolkit.slug}
            id={{ "data-composio-toolkit": toolkit.slug }}
            logo={
              <span className={cn(LOGO_TILE_CLASS_NAME, LOGO_SIZE_CLASS_NAME)}>
                {toolkit.logoUrl ? (
                  <img alt="" className="size-full object-contain" src={toolkit.logoUrl} />
                ) : (
                  <span aria-hidden="true" className="text-sm font-medium text-muted-foreground">
                    {toolkit.name.slice(0, 1).toUpperCase()}
                  </span>
                )}
              </span>
            }
            title={toolkit.name}
            description={
              toolkit.description ??
              plural(toolkit.toolsCount, { one: "{count} tool", other: "{count} tools" })
            }
            status={[t("via Composio")]}
            action={
              <Button
                aria-label={t("{action} {name}", {
                  action: connected ? t("Connected") : t("Connect"),
                  name: toolkit.name,
                })}
                className="min-w-18 shrink-0"
                disabled={connected || pendingToolkitId === toolkit.slug}
                size="pill"
                variant={connected ? "ghost-muted" : "outline"}
                onClick={() => onConnect(toolkit)}
              >
                {connected ? t("Connected") : t("Connect")}
              </Button>
            }
          />
        );
      })}
    </DirectorySection>
  );
}
