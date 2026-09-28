import type { McpServer, McpServerId, ProviderAccessStatus } from "@t3tools/contracts";
import { InfoIcon, ServerIcon } from "lucide-react";
import { useMemo, type ReactNode } from "react";

import { cn } from "../../lib/utils";
import { openPlugins } from "../../pluginsDialogStore";
import { SettingsRow, SettingsSection } from "../settings/settingsLayout";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import {
  botToolStatus,
  buildBotToolItems,
  isBotToolEnabled,
  planBotToolToggle,
  type BotToolItem,
  type BotToolStatus,
} from "./botTools.logic";

const STATUS_LABEL: Record<BotToolStatus, string> = {
  connected: "Connected",
  "needs-setup": "Needs setup",
  error: "Error",
};

const STATUS_DOT: Record<BotToolStatus, string> = {
  connected: "bg-success",
  "needs-setup": "bg-warning",
  error: "bg-destructive",
};

/**
 * One per-bot capability with an on/off switch. Tools use it today; per-bot
 * integrations can reuse it by passing their own icon, copy, and status.
 */
export function BotToggleRow({
  icon,
  name,
  description,
  status,
  checked,
  disabled = false,
  onCheckedChange,
}: {
  readonly icon: ReactNode;
  readonly name: string;
  readonly description: string;
  readonly status: BotToolStatus | null;
  readonly checked: boolean;
  readonly disabled?: boolean;
  readonly onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <SettingsRow
      title={
        <span className="flex min-w-0 items-center gap-2">
          <span className="flex size-5 shrink-0 items-center justify-center overflow-hidden rounded-md text-muted-foreground">
            {icon}
          </span>
          <span className="truncate">{name}</span>
        </span>
      }
      description={<span className="line-clamp-1 break-all">{description}</span>}
      control={
        <>
          {status ? (
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span aria-hidden className={cn("size-1.5 rounded-full", STATUS_DOT[status])} />
              {STATUS_LABEL[status]}
            </span>
          ) : null}
          <Switch
            checked={checked}
            disabled={disabled}
            onCheckedChange={(next) => onCheckedChange(Boolean(next))}
            aria-label={`${checked ? "Turn off" : "Turn on"} ${name} for this bot`}
          />
        </>
      }
    />
  );
}

function ToolIcon({ item }: { readonly item: BotToolItem }) {
  if (!item.logo) return <ServerIcon className="size-4" />;
  return (
    <picture>
      {item.logo.darkSrc ? (
        <source media="(prefers-color-scheme: dark)" srcSet={item.logo.darkSrc} />
      ) : null}
      <img src={item.logo.src} alt="" className="size-5 object-contain" />
    </picture>
  );
}

/** The bot settings section that picks which workspace tools this bot may use. */
export function BotToolsSection({
  servers,
  accessStatuses,
  disabledIds,
  onDisabledIdsChange,
  canDelegate = true,
}: {
  readonly servers: readonly McpServer[];
  readonly accessStatuses: readonly ProviderAccessStatus[];
  readonly disabledIds: readonly McpServerId[];
  readonly onDisabledIdsChange: (ids: readonly McpServerId[]) => void;
  /** False when the bot's provider can neither hand off work nor receive it. */
  readonly canDelegate?: boolean;
}) {
  // Memoized because this walks the plugin catalog and does not depend on the form draft.
  const items = useMemo(() => buildBotToolItems(servers), [servers]);

  return (
    <SettingsSection
      id="tools"
      title="Tools"
      headerAction={
        <Button variant="ghost" size="xs" type="button" onClick={() => openPlugins()}>
          Manage plugins
        </Button>
      }
    >
      {canDelegate ? null : (
        <p role="note" className="flex items-start gap-2 px-4 py-3 text-xs text-muted-foreground">
          <InfoIcon className="mt-px size-3.5 shrink-0" />
          <span>
            This bot's provider cannot hand off work. It cannot send work to other bots or receive
            work from them.
          </span>
        </p>
      )}
      {items.length === 0 ? (
        <SettingsRow
          title="No tools yet"
          description="Add a plugin or an MCP server in Plugins. It shows up here, and you can turn it on or off for this bot."
        />
      ) : (
        items.map((item) => (
          <BotToggleRow
            key={item.id}
            icon={<ToolIcon item={item} />}
            name={item.name}
            description={item.description}
            status={botToolStatus(item, accessStatuses)}
            checked={isBotToolEnabled(item, disabledIds)}
            disabled={!item.workspaceEnabled}
            onCheckedChange={(enabled) =>
              onDisabledIdsChange(planBotToolToggle(disabledIds, item.id, enabled))
            }
          />
        ))
      )}
    </SettingsSection>
  );
}
