import {
  AlertCircleIcon,
  BotIcon,
  BrowserIcon,
  CallIcon,
  Bug02Icon,
  GitBranchIcon,
  HardDriveIcon,
  Image01Icon,
  KeyboardIcon,
  Link02Icon,
  Message01Icon,
  PaintBrush01Icon,
  SecurityCheckIcon,
  Settings02Icon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { Suspense, lazy, useState, type ComponentType } from "react";
import { useI18n } from "../../i18n";
import { searchSettings, SETTINGS_SECTION_LABELS } from "./settingsSearch";
import { settingsSectionFromPathname } from "../../settingsDialogStore";

import { cn } from "~/lib/utils";
import { Dialog, DialogPopup, DialogTitle } from "~/components/ui/dialog";
import { AppIcon } from "~/components/ui/app-icon";
import { Skeleton } from "~/components/ui/skeleton";
import { closeSettings, useSettingsDialogStore, type SettingsSection } from "~/settingsDialogStore";

const GeneralSettingsPanel = lazy(async () => ({
  default: (await import("./SettingsPanels")).GeneralSettingsPanel,
}));
const AppearanceSettingsPanel = lazy(async () => ({
  default: (await import("./SettingsPanels")).AppearanceSettingsPanel,
}));
const InboxPanel = lazy(async () => ({
  default: (await import("./InboxPanel")).InboxPanel,
}));
const ProvidersPanel = lazy(async () => ({
  default: (await import("./ProvidersPanel")).ProvidersPanel,
}));
const BrowserSettingsPanel = lazy(async () => ({
  default: (await import("./BrowserSettings")).BrowserSettingsPanel,
}));
const PluginsSettingsPanel = lazy(async () => ({
  default: (await import("./PluginsSettings")).PluginsSettingsPanel,
}));
const BotChannelsSettingsPanel = lazy(async () => ({
  default: (await import("./BotChannelsSettings")).BotChannelsSettingsPanel,
}));
const VoiceSettingsPanel = lazy(async () => ({
  default: (await import("./VoiceSettings")).VoiceSettingsPanel,
}));
const SandboxSettingsPanel = lazy(async () => ({
  default: (await import("./SandboxSettingsPanel")).SandboxSettingsPanel,
}));
const PrivacySettingsPanel = lazy(async () => ({
  default: (await import("./PrivacySettings")).PrivacySettingsPanel,
}));
const ConnectionsSettings = lazy(async () => ({
  default: (await import("./ConnectionsSettings")).ConnectionsSettings,
}));
const KeybindingsSettingsPanel = lazy(async () => ({
  default: (await import("./KeybindingsSettings")).KeybindingsSettingsPanel,
}));
const SourceControlSettingsPanel = lazy(async () => ({
  default: (await import("./SourceControlSettings")).SourceControlSettingsPanel,
}));
const ImageGenerationSettingsPanel = lazy(async () => ({
  default: (await import("./ImageGenerationSettings")).ImageGenerationSettingsPanel,
}));
const DiagnosticsSettingsPanel = lazy(async () => ({
  default: (await import("./DiagnosticsSettings")).DiagnosticsSettingsPanel,
}));

const SECTION_PANELS: Readonly<Record<SettingsSection, ComponentType>> = {
  general: GeneralSettingsPanel,
  inbox: InboxPanel,
  appearance: AppearanceSettingsPanel,
  providers: ProvidersPanel,
  browser: BrowserSettingsPanel,
  plugins: PluginsSettingsPanel,
  channels: BotChannelsSettingsPanel,
  sandbox: SandboxSettingsPanel,
  voice: VoiceSettingsPanel,
  "image-generation": ImageGenerationSettingsPanel,
  privacy: PrivacySettingsPanel,
  connections: ConnectionsSettings,
  keybindings: KeybindingsSettingsPanel,
  "source-control": SourceControlSettingsPanel,
  diagnostics: DiagnosticsSettingsPanel,
};

/**
 * Panels arrive by lazy chunk, so the wait is short and its length is known.
 * A skeleton in the shape of the incoming rows reads as "this is loading and
 * here is what lands", where a spinner centered in an empty page read as
 * "something is wrong".
 */
function SettingsPanelSkeleton() {
  const { t } = useI18n();
  return (
    <div className="flex-1 overflow-hidden px-5 pt-6 sm:px-6">
      {/* The placeholder bars carry no information, so they stay hidden from
          assistive tech; this announces the wait instead. */}
      <span className="sr-only" role="status">
        {t("Loading settings")}
      </span>
      <div aria-hidden className="mx-auto flex w-full max-w-4xl flex-col gap-8">
        <Skeleton className="h-6 w-40 rounded-md" />
        <div className="flex flex-col gap-1">
          {[0, 1, 2, 3].map((row) => (
            <div key={row} className="flex items-center justify-between gap-8 px-3 py-3 sm:px-4">
              <div className="flex min-w-0 flex-1 flex-col gap-2">
                <Skeleton className="h-4 w-44 rounded-md" />
                <Skeleton className="h-3 w-72 max-w-full rounded-md" />
              </div>
              <Skeleton className="h-8 w-28 shrink-0 rounded-md" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function SettingsPanelForSection({ section }: { readonly section: SettingsSection }) {
  const Panel = SECTION_PANELS[section];
  return (
    <Suspense fallback={<SettingsPanelSkeleton />}>
      <Panel />
    </Suspense>
  );
}

export interface SettingsNavItem {
  readonly section: SettingsSection;
  readonly label: string;
  readonly icon: IconSvgElement;
}

/**
 * Nav rows, grouped by what the user is trying to change rather than by which
 * subsystem owns the setting. A flat list of fourteen peers gave "Diagnostics"
 * the same weight as "Appearance"; grouping lets the rail be skimmed, and
 * keeps the rarely-correct answers (Advanced) out of the way at the end.
 * Anything not listed here is reached from a link inside a panel.
 */
export const SETTINGS_NAV_GROUPS: ReadonlyArray<{
  readonly id: string;
  readonly label: string;
  readonly items: ReadonlyArray<SettingsNavItem>;
}> = [
  {
    id: "general",
    label: "General",
    items: [
      { section: "general", label: "General", icon: Settings02Icon },
      { section: "appearance", label: "Appearance", icon: PaintBrush01Icon },
      { section: "keybindings", label: "Keybindings", icon: KeyboardIcon },
    ],
  },
  {
    id: "bots",
    label: "Bots",
    items: [
      { section: "providers", label: "Providers", icon: BotIcon },
      { section: "channels", label: "Bot channels", icon: Message01Icon },
      { section: "voice", label: "Voice", icon: CallIcon },
      { section: "image-generation", label: "Image generation", icon: Image01Icon },
    ],
  },
  {
    id: "workspace",
    label: "Workspace",
    items: [
      { section: "browser", label: "Browser", icon: BrowserIcon },
      { section: "plugins", label: "Plugins", icon: Link02Icon },
      { section: "sandbox", label: "Sandbox", icon: HardDriveIcon },
    ],
  },
  {
    id: "data",
    label: "Privacy and data",
    items: [
      { section: "privacy", label: "Privacy", icon: SecurityCheckIcon },
      { section: "connections", label: "Connections", icon: Link02Icon },
    ],
  },
  {
    id: "advanced",
    label: "Advanced",
    items: [
      { section: "source-control", label: "Source control", icon: GitBranchIcon },
      { section: "inbox", label: "Bot inbox", icon: AlertCircleIcon },
      { section: "diagnostics", label: "Diagnostics", icon: Bug02Icon },
    ],
  },
];

/** Flattened nav rows in visual order, for lookups and non-grouped surfaces. */
export const SETTINGS_NAV_ITEMS: ReadonlyArray<SettingsNavItem> = SETTINGS_NAV_GROUPS.flatMap(
  (group) => group.items,
);

export function SettingsDialog() {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const searchResults = searchSettings(query, undefined, t).filter(
    (item) => item.to !== "/settings/archived",
  );
  const section = useSettingsDialogStore((state) => state.section);
  const openSettings = useSettingsDialogStore((state) => state.openSettings);

  return (
    <Dialog
      open={section !== null}
      onOpenChange={(open) => {
        if (!open) closeSettings();
      }}
    >
      <DialogPopup
        className="h-[min(44rem,88dvh)] max-w-4xl flex-row overflow-hidden max-sm:flex-col"
        bottomStickOnMobile={false}
      >
        <DialogTitle className="sr-only">{t("Settings")}</DialogTitle>
        <nav
          aria-label={t("Settings sections")}
          // Narrow layouts scroll the nav horizontally underneath the absolute
          // close control, so reserve its width at the end: the padding keeps
          // the last row reachable, and the scroll padding stops a scrolled row
          // from resting beneath the button.
          className="flex w-52 shrink-0 flex-col gap-4 overflow-y-auto border-e bg-muted/30 p-2 max-sm:w-full max-sm:flex-row max-sm:gap-2 max-sm:overflow-x-auto max-sm:scroll-pe-12 max-sm:border-e-0 max-sm:border-b max-sm:pe-12"
        >
          <input
            type="search"
            aria-label={t("Search settings")}
            placeholder={t("Search settings")}
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            className="h-8 min-w-0 shrink-0 rounded-md border bg-background px-2 text-sm max-sm:w-40"
          />
          {query.trim() ? (
            <div className="flex flex-col gap-0.5 max-sm:flex-row">
              {searchResults.length ? (
                searchResults.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    data-setting-id={item.id}
                    onClick={() => {
                      openSettings(settingsSectionFromPathname(item.to), item.targetId ?? item.id);
                      setQuery("");
                    }}
                    className="shrink-0 rounded-md px-2 py-1.5 text-start text-sm hover:bg-accent/50"
                  >
                    <span className="block">{t(item.title)}</span>
                    <span className="block text-xs text-muted-foreground">
                      {t(SETTINGS_SECTION_LABELS[item.to])}
                    </span>
                  </button>
                ))
              ) : (
                <p role="status" className="px-2 text-sm text-muted-foreground">
                  {t("No settings found")}
                </p>
              )}
            </div>
          ) : (
            SETTINGS_NAV_GROUPS.map((group) => (
              <div key={group.id} className="flex flex-col gap-0.5 max-sm:flex-row">
                <div className="px-2 py-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70 max-sm:hidden">
                  {t(group.label)}
                </div>
                {group.items.map((item) => {
                  const isActive = section === item.section;
                  return (
                    <button
                      key={item.section}
                      type="button"
                      aria-current={isActive ? "page" : undefined}
                      onClick={() => openSettings(item.section)}
                      className={cn(
                        "flex h-8 shrink-0 items-center gap-2 rounded-md px-2 text-sm font-medium transition-colors duration-[var(--motion-duration-fast)] ease-[var(--motion-ease-standard)]",
                        isActive
                          ? "bg-selected text-selected-foreground"
                          : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                      )}
                    >
                      <AppIcon className="size-4 shrink-0" icon={item.icon} />
                      <span className="truncate">{t(item.label)}</span>
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </nav>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {section ? <SettingsPanelForSection section={section} /> : null}
        </div>
      </DialogPopup>
    </Dialog>
  );
}
