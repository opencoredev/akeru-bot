import type { McpServer, ProviderAccessStatus } from "@akeru/contracts";
import type { ReactNode } from "react";
import type { PluginDirectoryDefinition } from "../../../../../plugins";
import { useI18n } from "../../i18n";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { pluginLabel } from "./pluginLabel";
import {
  pluginBrokerName,
  pluginConnectionLabel,
  pluginPrimaryAction,
  type PluginPrimaryAction,
} from "./pluginPresentation";

export const LOGO_TILE_CLASS_NAME =
  "flex shrink-0 items-center justify-center overflow-hidden rounded-[10px] bg-muted/70 p-2 ring-1 ring-border/50 ring-inset";
export const ROW_CLASS_NAME =
  "group flex min-w-0 items-center gap-3 rounded-xl px-2.5 py-2.5 transition-colors hover:bg-muted/50";
const ACTION_CLASS_NAME = "min-w-18 shrink-0";
export const LOGO_SIZE_CLASS_NAME = "size-11 rounded-xl";

export function PluginLogoImage({
  plugin,
  className = "size-10",
}: {
  readonly plugin: PluginDirectoryDefinition;
  readonly className?: string;
}) {
  return (
    <span aria-hidden="true" className={cn(LOGO_TILE_CLASS_NAME, className)}>
      <img
        alt=""
        className={`size-full object-contain ${plugin.logo.darkSrc ? "dark:hidden" : ""}`}
        src={plugin.logo.src}
      />
      {plugin.logo.darkSrc ? (
        <img
          alt=""
          className="hidden size-full object-contain dark:block"
          src={plugin.logo.darkSrc}
        />
      ) : null}
    </span>
  );
}

export function McpLogo() {
  return (
    <span aria-hidden="true" className={cn(LOGO_TILE_CLASS_NAME, "size-10")}>
      <img alt="" className="size-full object-contain dark:hidden" src="/plugin-logos/mcp.svg" />
      <img
        alt=""
        className="hidden size-full object-contain dark:block"
        src="/plugin-logos/mcp-dark.svg"
      />
    </span>
  );
}

/** Name, quiet meta, and a short description for one directory row. */
export function RowText({
  title,
  meta,
  description,
}: {
  readonly title: string;
  readonly meta?: readonly (string | null | false | undefined)[];
  readonly description: string;
}) {
  const metaText = (meta ?? []).filter(Boolean).join(" · ");
  return (
    <div className="min-w-0 flex-1">
      <div className="flex min-w-0 items-baseline gap-2">
        <h3 className="truncate text-sm font-medium leading-5 text-foreground">{title}</h3>
        {metaText ? (
          <span className="shrink-0 truncate text-xs text-muted-foreground/80">{metaText}</span>
        ) : null}
      </div>
      <p className="line-clamp-2 text-[13px] leading-5 text-muted-foreground sm:line-clamp-1">
        {description}
      </p>
    </div>
  );
}

const CARD_GRID_CLASS_NAME = {
  grid: "grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3",
  // Featured holds a handful of picks, so it runs one column wider.
  featured: "grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4",
  list: "flex flex-col gap-0.5",
};

/** Groups cards (or rows) under a section heading with a quiet count. */
export function DirectorySection({
  label,
  labelId,
  count,
  trailing,
  layout = "grid",
  children,
}: {
  readonly label: string;
  readonly labelId?: string;
  readonly count?: number;
  readonly trailing?: ReactNode;
  readonly layout?: keyof typeof CARD_GRID_CLASS_NAME;
  readonly children: ReactNode;
}) {
  return (
    <section {...(labelId ? { "aria-labelledby": labelId } : { "aria-label": label })}>
      <div className="mb-3 flex h-7 items-center justify-between gap-3 px-1">
        <h2
          className="flex items-baseline gap-2 text-[15px] font-semibold text-foreground"
          id={labelId}
        >
          {label}
          {count !== undefined ? (
            <span className="text-xs font-normal tabular-nums text-muted-foreground/70">
              {count}
            </span>
          ) : null}
        </h2>
        {trailing}
      </div>
      <div className={CARD_GRID_CLASS_NAME[layout]}>{children}</div>
    </section>
  );
}

const CARD_CLASS_NAME =
  "group relative flex min-h-34 min-w-0 flex-col rounded-2xl border border-border/70 bg-card p-4 shadow-[0_1px_2px_rgb(0_0_0/3%)] transition-[border-color,background-color,box-shadow] duration-(--duration-fast) ease-(--ease-smooth-out) hover:border-border hover:shadow-[0_1px_2px_rgb(0_0_0/4%),0_6px_16px_-8px_rgb(0_0_0/12%)] motion-reduce:transition-none has-[[data-card-open]:focus-visible]:ring-2 has-[[data-card-open]:focus-visible]:ring-ring";

/** One directory card. The whole card opens details; the action sits above that hit area. */
export function DirectoryCard({
  id,
  logo,
  title,
  description,
  status,
  openLabel,
  onOpen,
  action,
}: {
  readonly id: { readonly [key: `data-${string}`]: string };
  readonly logo: ReactNode;
  readonly title: string;
  readonly description: string;
  readonly status: readonly (string | null | false | undefined)[];
  readonly openLabel?: string;
  readonly onOpen?: () => void;
  readonly action: ReactNode;
}) {
  const statusText = status.filter(Boolean).join(" · ");
  return (
    <article className={CARD_CLASS_NAME} {...id}>
      {onOpen ? (
        <button
          aria-label={openLabel}
          className="absolute inset-0 cursor-pointer rounded-2xl outline-hidden"
          data-card-open=""
          type="button"
          onClick={onOpen}
        />
      ) : null}
      <div className="pointer-events-none flex min-w-0 items-start gap-3">
        {logo}
        <div className="min-w-0 flex-1 pt-0.5">
          <h3 className="truncate text-sm font-semibold leading-5 text-foreground">{title}</h3>
          <p className="mt-1 line-clamp-2 text-[13px] leading-5 text-muted-foreground">
            {description}
          </p>
        </div>
      </div>
      <div className="mt-auto flex min-h-8 items-end justify-between gap-3 pt-4">
        <span className="pointer-events-none min-w-0 truncate text-xs text-muted-foreground/80">
          {statusText}
        </span>
        <div className="relative">{action}</div>
      </div>
    </article>
  );
}

function actionVariant(action: PluginPrimaryAction) {
  return action.enable === true ? "outline" : "ghost-muted";
}

export function PluginCard({
  plugin,
  server,
  accessStatus,
  pending,
  onToggle,
  onOpen,
}: {
  readonly plugin: PluginDirectoryDefinition;
  readonly server: McpServer | undefined;
  readonly accessStatus: ProviderAccessStatus | undefined;
  readonly pending: boolean;
  readonly onToggle: (enabled: boolean) => void;
  readonly onOpen: () => void;
}) {
  const { t } = useI18n();
  const action = pluginPrimaryAction(plugin, server, accessStatus);
  const actionLabel = pluginLabel(action.label, t);
  const brokerName = pluginBrokerName(plugin);
  const awaitingVendor =
    plugin.connection.type === "approval-pending" ||
    plugin.connection.type === "verification-pending";
  const connected = server?.enabled === true && action.enable === false;
  return (
    <DirectoryCard
      id={{ "data-plugin-id": plugin.id }}
      logo={<PluginLogoImage plugin={plugin} className={LOGO_SIZE_CLASS_NAME} />}
      title={plugin.title}
      description={plugin.description}
      status={[
        connected && t("Connected"),
        awaitingVendor && pluginLabel(pluginConnectionLabel(plugin), t),
        brokerName && t("via {name}", { name: brokerName }),
      ]}
      openLabel={t("Open {name}", { name: plugin.title })}
      onOpen={onOpen}
      action={
        <Button
          aria-label={t("{action} {name}", { action: actionLabel, name: plugin.title })}
          className={ACTION_CLASS_NAME}
          size="pill"
          variant={actionVariant(action)}
          disabled={pending || action.enable === null}
          title={action.blocker}
          onClick={() => action.enable !== null && onToggle(action.enable)}
        >
          {actionLabel}
        </Button>
      }
    />
  );
}
