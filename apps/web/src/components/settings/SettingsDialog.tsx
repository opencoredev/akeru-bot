import {
  AlertCircleIcon,
  BotIcon,
  CallIcon,
  HardDriveIcon,
  KeyboardIcon,
  Link02Icon,
  PaintBrush01Icon,
  SecurityCheckIcon,
  Settings02Icon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { Suspense, lazy, type ComponentType } from "react";

import { cn } from "~/lib/utils";
import { Dialog, DialogPopup, DialogTitle } from "~/components/ui/dialog";
import { AppIcon } from "~/components/ui/app-icon";
import { Spinner } from "~/components/ui/spinner";
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
const DiagnosticsSettingsPanel = lazy(async () => ({
  default: (await import("./DiagnosticsSettings")).DiagnosticsSettingsPanel,
}));

const SECTION_PANELS: Readonly<Record<SettingsSection, ComponentType>> = {
  general: GeneralSettingsPanel,
  inbox: InboxPanel,
  appearance: AppearanceSettingsPanel,
  providers: ProvidersPanel,
  sandbox: SandboxSettingsPanel,
  voice: VoiceSettingsPanel,
  privacy: PrivacySettingsPanel,
  connections: ConnectionsSettings,
  keybindings: KeybindingsSettingsPanel,
  "source-control": SourceControlSettingsPanel,
  diagnostics: DiagnosticsSettingsPanel,
};

/** Sections with a nav row. Anything else is reached from a link inside a panel. */
const NAV_ITEMS: ReadonlyArray<{
  readonly section: SettingsSection;
  readonly label: string;
  readonly icon: IconSvgElement;
}> = [
  { section: "general", label: "General", icon: Settings02Icon },
  { section: "appearance", label: "Appearance", icon: PaintBrush01Icon },
  { section: "providers", label: "Providers", icon: BotIcon },
  { section: "sandbox", label: "Sandbox", icon: HardDriveIcon },
  { section: "voice", label: "Voice", icon: CallIcon },
  { section: "privacy", label: "Privacy", icon: SecurityCheckIcon },
  { section: "inbox", label: "Errors", icon: AlertCircleIcon },
  { section: "connections", label: "Connections", icon: Link02Icon },
  { section: "keybindings", label: "Keybindings", icon: KeyboardIcon },
];

export function SettingsDialog() {
  const section = useSettingsDialogStore((state) => state.section);
  const openSettings = useSettingsDialogStore((state) => state.openSettings);
  const Panel = section ? SECTION_PANELS[section] : null;

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
        <DialogTitle className="sr-only">Settings</DialogTitle>
        <nav
          aria-label="Settings sections"
          className="flex w-52 shrink-0 flex-col gap-0.5 border-e bg-muted/30 p-2 max-sm:w-full max-sm:flex-row max-sm:overflow-x-auto max-sm:border-e-0 max-sm:border-b"
        >
          {NAV_ITEMS.map((item) => {
            const isActive = section === item.section;
            return (
              <button
                key={item.section}
                type="button"
                aria-current={isActive ? "page" : undefined}
                onClick={() => openSettings(item.section)}
                className={cn(
                  "flex h-8 shrink-0 items-center gap-2 rounded-md px-2 text-sm font-medium transition-colors",
                  isActive
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                )}
              >
                <AppIcon className="size-4 shrink-0" icon={item.icon} />
                <span className="truncate">{item.label}</span>
              </button>
            );
          })}
        </nav>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <Suspense
            fallback={
              <div className="flex flex-1 items-center justify-center">
                <Spinner />
              </div>
            }
          >
            {Panel ? <Panel /> : null}
          </Suspense>
        </div>
      </DialogPopup>
    </Dialog>
  );
}
