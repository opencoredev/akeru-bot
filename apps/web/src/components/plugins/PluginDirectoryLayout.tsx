import { Cancel01Icon, PuzzleIcon, Search01Icon } from "@hugeicons/core-free-icons";
import { useLayoutEffect, useRef, type ReactNode } from "react";

import { isElectron } from "../../env";
import { useI18n } from "../../i18n";
import { cn } from "../../lib/utils";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { AppIcon } from "../ui/app-icon";
import { DialogHeader, DialogPanel, DialogTitle } from "../ui/dialog";
import { ScrollArea } from "../ui/scroll-area";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { pluginLabel } from "./pluginLabel";
import { PLUGIN_DIRECTORY_FILTERS } from "./pluginDirectoryCatalog";
import type { PluginFilter } from "./pluginPresentation";

const ALL_CATEGORIES_VALUE = "all-categories";

const PRIMARY_FILTERS = ["All", "Featured", "Installed"] as const satisfies readonly PluginFilter[];

export const PLUGIN_DIRECTORY_HEADER_CLASS_NAME = "shrink-0";

export const PLUGIN_DIRECTORY_PANEL_CLASS_NAME = "space-y-8";

export const PLUGIN_PAGE_COLUMN_CLASS_NAME =
  "mx-auto flex w-full max-w-6xl flex-col px-4 pt-0 pb-16 sm:px-10 sm:pt-1";

function isPrimaryFilter(filter: PluginFilter): filter is (typeof PRIMARY_FILTERS)[number] {
  return (PRIMARY_FILTERS as readonly PluginFilter[]).includes(filter);
}

/** Toolbar search field: card fill with a leading icon. */
export function PluginSearchField({
  query,
  onQueryChange,
}: {
  readonly query: string;
  readonly onQueryChange: (query: string) => void;
}) {
  const { t } = useI18n();

  return (
    <div className="relative">
      <AppIcon
        icon={Search01Icon}
        className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
      />
      <input
        aria-label={t("Search plugins")}
        autoComplete="off"
        className="h-9 w-full rounded-xl border border-border/80 bg-card ps-9 pe-9 text-sm text-foreground shadow-xs outline-none transition-border-shadow placeholder:text-muted-foreground focus-visible:border-ring/60 focus-visible:ring-3 focus-visible:ring-ring/15 [&::-webkit-search-cancel-button]:appearance-none"
        placeholder={t("Search plugins")}
        spellCheck={false}
        type="search"
        value={query}
        onChange={(event) => onQueryChange(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && query) {
            event.stopPropagation();
            onQueryChange("");
          }
        }}
      />
      {query ? (
        <button
          aria-label={t("Clear search")}
          className="absolute end-1.5 top-1/2 flex size-6 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full text-muted-foreground outline-hidden transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          type="button"
          onClick={() => onQueryChange("")}
        >
          <AppIcon icon={Cancel01Icon} className="size-3.5" />
        </button>
      ) : null}
    </div>
  );
}

/**
 * Moves the segmented control's pill under the pressed button. The first placement,
 * resizes, and reappearing after a category was chosen skip the slide.
 */
function useSegmentPill(active: string | null) {
  const barRef = useRef<HTMLDivElement>(null);
  const pillRef = useRef<HTMLSpanElement>(null);
  const shownRef = useRef(false);

  useLayoutEffect(() => {
    const bar = barRef.current;
    const pill = pillRef.current;

    if (!bar || !pill) return;

    const place = (instant: boolean) => {
      const target = bar.querySelector<HTMLElement>('[aria-pressed="true"]');

      if (!target) {
        pill.style.opacity = "0";
        shownRef.current = false;

        return;
      }

      if (instant || !shownRef.current) pill.style.transition = "none";
      pill.style.translate = `${target.offsetLeft}px 0`;
      pill.style.width = `${target.offsetWidth}px`;
      pill.style.opacity = "1";

      if (pill.style.transition === "none") {
        void pill.offsetWidth;
        pill.style.transition = "";
      }

      shownRef.current = true;
    };

    place(false);
    const observer = new ResizeObserver(() => place(true));
    observer.observe(bar);

    return () => observer.disconnect();
  }, [active]);

  return { barRef, pillRef };
}

/**
 * Directory filters: a small segmented control for the three views plus one
 * category menu, so eleven categories never crowd the page.
 */
export function PluginFilterBar({
  filter,
  onFilterChange,
}: {
  readonly filter: PluginFilter;
  readonly onFilterChange: (filter: PluginFilter) => void;
}) {
  const { t } = useI18n();
  const categories = PLUGIN_DIRECTORY_FILTERS.filter((item) => !isPrimaryFilter(item));
  const category = isPrimaryFilter(filter) ? null : filter;
  const { barRef, pillRef } = useSegmentPill(category ? null : filter);

  return (
    <div
      aria-label={t("Plugin sections and categories")}
      className="flex flex-wrap items-center justify-between gap-2"
      role="group"
    >
      <div className="relative inline-flex rounded-10px bg-muted/70 p-0.5" ref={barRef}>
        <span
          aria-hidden="true"
          className="motion-segment-pill pointer-events-none absolute inset-y-0.5 left-0 rounded-lg bg-card opacity-0 shadow-xs ring-1 ring-border/60"
          ref={pillRef}
        />
        {PRIMARY_FILTERS.map((item) => (
          <button
            aria-pressed={filter === item}
            className={cn(
              "relative h-7 cursor-pointer rounded-lg px-3 text-13px outline-hidden transition-colors duration-(--duration-fast) ease-(--ease-smooth-out) focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
              filter === item
                ? "font-medium text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
            key={item}
            type="button"
            onClick={() => onFilterChange(item)}
          >
            {pluginLabel(item, t)}
          </button>
        ))}
      </div>
      {categories.length > 0 ? (
        <Select
          value={category ?? ALL_CATEGORIES_VALUE}
          onValueChange={(value) => {
            const next = PLUGIN_DIRECTORY_FILTERS.find((item) => item === value);
            onFilterChange(next ?? "All");
          }}
        >
          <SelectTrigger
            aria-label={t("Plugin category")}
            className={cn("h-8", category && "text-foreground")}
            size="sm-dense"
            variant="ghost"
          >
            <SelectValue>{category ? pluginLabel(category, t) : t("All categories")}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            <SelectItem value={ALL_CATEGORIES_VALUE}>{t("All categories")}</SelectItem>
            {categories.map((item) => (
              <SelectItem key={item} value={item}>
                {pluginLabel(item, t)}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      ) : null}
    </div>
  );
}

/** Standalone page header shared by the directory and plugin details. */
export function PluginsPageHeader({ children }: { readonly children?: ReactNode }) {
  const { t } = useI18n();

  return (
    <WorkspacePageHeader electron={isElectron}>
      {children ?? (
        <div className="flex min-w-0 items-center gap-2">
          <AppIcon icon={PuzzleIcon} className="size-4 shrink-0 text-muted-foreground" />
          <h1 className="truncate text-sm font-medium text-foreground">{t("Plugins")}</h1>
        </div>
      )}
    </WorkspacePageHeader>
  );
}

/** Places search, filters, and results in either the dialog or the workspace page. */
export function PluginDirectoryLayout({
  standalone,
  search,
  filters,
  returning,
  children,
}: {
  readonly standalone: boolean;
  readonly search: ReactNode;
  readonly filters: ReactNode;
  /** True when the directory remounts after leaving plugin details. */
  readonly returning: boolean;
  readonly children: ReactNode;
}) {
  const { t } = useI18n();

  if (!standalone) {
    return (
      <>
        <DialogHeader variant="directory" className={PLUGIN_DIRECTORY_HEADER_CLASS_NAME}>
          <div className="pe-8">
            <DialogTitle>{t("Plugins")}</DialogTitle>
          </div>
          {search}
          {filters}
        </DialogHeader>
        <DialogPanel
          variant="directory"
          className={cn(PLUGIN_DIRECTORY_PANEL_CLASS_NAME, returning && "motion-page-back")}
        >
          {children}
        </DialogPanel>
      </>
    );
  }

  return (
    <>
      <PluginsPageHeader>
        <span />
      </PluginsPageHeader>
      <ScrollArea className="min-h-0 flex-1" scrollFade>
        <div
          className={cn(
            PLUGIN_PAGE_COLUMN_CLASS_NAME,
            returning ? "motion-page-back" : "motion-section-enter",
          )}
        >
          <div className="px-1">
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">
              {t("Plugins")}
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {t("Connect a listed integration, or follow a setup guide from integrations.sh.")}
            </p>
          </div>
          <div className="mt-6 mb-8 flex flex-col gap-3 sm:flex-row sm:items-center">
            <div className="w-full sm:max-w-sm sm:flex-1">{search}</div>
            <div className="min-w-0 flex-1">{filters}</div>
          </div>
          <div className="space-y-10">{children}</div>
        </div>
      </ScrollArea>
    </>
  );
}
