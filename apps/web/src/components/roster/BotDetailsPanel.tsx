import { useAtomValue } from "@effect/atom-react";
import {
  ProviderInstanceId,
  type BotEngine,
  type EnvironmentId,
  type McpServerId,
} from "@t3tools/contracts";
import {
  Cancel01Icon,
  Edit02Icon,
  Link02Icon,
  PanelRightCloseIcon,
  PanelRightIcon,
  WrenchIcon,
} from "@hugeicons/core-free-icons";
import { useEffect, useMemo, useReducer, useState, type ReactNode } from "react";

import { usePrimarySettings } from "../../hooks/useSettings";
import { resolveShortcutCommand, shortcutLabelForCommand } from "../../keybindings";
import { RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY } from "../../rightPanelLayout";
import {
  getCustomModelOptionsByInstance,
  resolveAppModelSelectionForInstance,
  resolveAppModelSelectionState,
} from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  resolveSelectableProviderInstanceEntry,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { environmentMcpServersAtom } from "../../state/mcpServers";
import { primaryServerKeybindingsAtom, primaryServerProvidersAtom } from "../../state/server";
import { AppIcon } from "../ui/app-icon";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Sheet, SheetClose, SheetPopup, SheetTitle } from "../ui/sheet";
import { Textarea } from "../ui/textarea";
import { Switch } from "../ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { AvatarPickerDialog } from "./AvatarPickerDialog";
import { BotAvatarView } from "./BotAvatarView";
import { BotChannelsSheet } from "./BotChannelsSheet";
import { BotModelPicker } from "./BotModelPicker";
import {
  BOT_SANDBOX_OPTIONS,
  botSandboxChoice,
  botSandboxLabel,
  type BotSandboxChoice,
} from "./botSandbox";
import { BotToolsSheet, buildBotToolItems } from "./BotToolsSheet";
import type { Bot } from "./types";

const NO_ENVIRONMENT = "" as EnvironmentId;

type BotDetailsPanelState = {
  readonly desktopOpen: boolean;
  readonly mobileOpen: boolean;
};

type BotDetailsPanelAction =
  | { readonly type: "toggle-desktop" }
  | { readonly type: "toggle-mobile" }
  | { readonly type: "set-mobile"; readonly open: boolean };

export function reduceBotDetailsPanelState(
  state: BotDetailsPanelState,
  action: BotDetailsPanelAction,
): BotDetailsPanelState {
  if (action.type === "toggle-desktop") {
    return { ...state, desktopOpen: !state.desktopOpen };
  }
  if (action.type === "toggle-mobile") {
    return { ...state, mobileOpen: !state.mobileOpen };
  }
  return { ...state, mobileOpen: action.open };
}

export interface BotProfileUpdate {
  readonly name: string;
  readonly label: string | null;
  readonly description: string | null;
  readonly engine: BotEngine | null;
  readonly sandbox: Bot["sandbox"];
  readonly voiceEnabled: boolean;
  readonly disabledMcpServerIds: readonly McpServerId[];
}

function BotProfileEditor({
  bot,
  onSave,
}: {
  readonly bot: Bot;
  readonly onSave?: (input: BotProfileUpdate) => Promise<boolean>;
}) {
  const providers = useAtomValue(primaryServerProvidersAtom);
  const environmentId = usePrimaryEnvironmentId();
  const mcpServers = useAtomValue(environmentMcpServersAtom(environmentId ?? NO_ENVIRONMENT));
  const settings = usePrimarySettings();
  const [name, setName] = useState(bot.name);
  const [label, setLabel] = useState(bot.label ?? "");
  const [description, setDescription] = useState(bot.description ?? "");
  const [avatarOpen, setAvatarOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [engineChanged, setEngineChanged] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [channelsOpen, setChannelsOpen] = useState(false);
  const [sandbox, setSandbox] = useState<BotSandboxChoice>(() => botSandboxChoice(bot.sandbox));
  const [voiceEnabled, setVoiceEnabled] = useState(bot.voiceEnabled);
  const [disabledMcpServerIds, setDisabledMcpServerIds] = useState<readonly McpServerId[]>(
    bot.disabledMcpServerIds,
  );

  const instanceEntries = useMemo(
    () =>
      sortProviderInstanceEntries(
        applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings),
      ),
    [providers, settings],
  );
  const defaultSelection = useMemo(
    () => resolveAppModelSelectionState(settings, providers),
    [providers, settings],
  );
  const [provider, setProvider] = useState(bot.engine?.provider ?? defaultSelection.instanceId);
  const activeEntry = useMemo(
    () =>
      resolveSelectableProviderInstanceEntry(instanceEntries, ProviderInstanceId.make(provider)),
    [instanceEntries, provider],
  );
  const [model, setModel] = useState<string>(
    () =>
      bot.engine?.model ??
      (activeEntry
        ? resolveAppModelSelectionForInstance(activeEntry.instanceId, settings, providers, null)
        : null) ??
      defaultSelection.model,
  );
  const modelOptionsByInstance = useMemo(
    () => getCustomModelOptionsByInstance(settings, providers),
    [providers, settings],
  );

  useEffect(() => {
    if (engineChanged) return;
    setProvider(bot.engine?.provider ?? defaultSelection.instanceId);
    if (bot.engine?.model) setModel(bot.engine.model);
  }, [bot.engine, defaultSelection.instanceId, engineChanged]);

  const normalizedLabel = label.trim() || null;
  const normalizedDescription = description.trim() || null;
  const nextEngine: Bot["engine"] = engineChanged && model ? { provider, model } : bot.engine;
  const nextSandbox: Bot["sandbox"] = sandbox;
  const tools = useMemo(() => buildBotToolItems(mcpServers), [mcpServers]);
  const enabledToolCount = tools.filter(
    (tool) => tool.workspaceEnabled && !disabledMcpServerIds.includes(tool.id),
  ).length;
  const connectedChannelCount = (bot.channelBindings ?? []).filter(
    (binding) => binding.status !== "disconnected",
  ).length;
  const toolOverridesDirty =
    [...disabledMcpServerIds].sort().join("\u0000") !==
    [...bot.disabledMcpServerIds].sort().join("\u0000");
  const sandboxDirty = sandbox !== botSandboxChoice(bot.sandbox);
  const dirty =
    name.trim() !== bot.name ||
    normalizedLabel !== bot.label ||
    normalizedDescription !== bot.description ||
    engineChanged ||
    sandboxDirty ||
    voiceEnabled !== bot.voiceEnabled ||
    toolOverridesDirty;

  const markChanged = () => setSaved(false);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6">
      <div className="flex flex-col items-center pb-7 pt-6">
        <button
          type="button"
          aria-label="Change bot avatar"
          onClick={() => setAvatarOpen(true)}
          className="group relative rounded-2xl outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <BotAvatarView avatar={bot.avatar} name={name || bot.name} className="size-20" />
          <span className="absolute -bottom-1 -right-1 flex size-7 items-center justify-center rounded-full border border-border bg-background text-muted-foreground shadow-sm transition-colors group-hover:text-foreground">
            <AppIcon className="size-3.5" icon={Edit02Icon} />
          </span>
        </button>
      </div>

      <div className="space-y-5">
        <label className="block space-y-2 text-sm font-medium">
          Name
          <Input
            aria-label="Bot name"
            value={name}
            onChange={(event) => {
              setName(event.currentTarget.value);
              markChanged();
            }}
          />
        </label>

        <label className="block space-y-2 text-sm font-medium">
          <span>
            Label <span className="font-normal text-muted-foreground">(optional)</span>
          </span>
          <Input
            aria-label="Bot label"
            value={label}
            placeholder="Research, marketing, admin"
            onChange={(event) => {
              setLabel(event.currentTarget.value);
              markChanged();
            }}
          />
        </label>

        <label className="block space-y-2 text-sm font-medium">
          Description
          <Textarea
            aria-label="Bot description"
            value={description}
            placeholder="What this bot is for"
            rows={5}
            className="min-h-28 resize-none"
            onChange={(event) => {
              setDescription(event.currentTarget.value);
              markChanged();
            }}
          />
        </label>

        <div className="space-y-2">
          <div className="text-sm font-medium">Model</div>
          <div className="flex min-h-10 items-center rounded-lg border border-border bg-muted/20 px-2">
            {activeEntry && model ? (
              <BotModelPicker
                activeInstanceId={activeEntry.instanceId}
                model={model}
                instanceEntries={instanceEntries}
                modelOptionsByInstance={modelOptionsByInstance}
                onChange={(instanceId, nextModel) => {
                  setProvider(instanceId);
                  setModel(nextModel);
                  setEngineChanged(true);
                  markChanged();
                }}
              />
            ) : (
              <span className="px-1 text-sm text-muted-foreground">Connect a provider</span>
            )}
          </div>
        </div>

        <div className="space-y-2">
          <div className="text-sm font-medium">Sandbox</div>
          <Select
            value={sandbox}
            onValueChange={(value) => {
              if (value === null) return;
              if (!BOT_SANDBOX_OPTIONS.some((option) => option.value === value)) return;
              setSandbox(value as BotSandboxChoice);
              markChanged();
            }}
          >
            <SelectTrigger className="w-full bg-muted/20" aria-label="Sandbox provider">
              <SelectValue>{botSandboxLabel(sandbox)}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {BOT_SANDBOX_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>

        <div className="flex min-h-10 items-center justify-between rounded-lg border border-border bg-muted/20 px-3">
          <span className="text-sm font-medium">Voice calls</span>
          <Switch
            checked={voiceEnabled}
            onCheckedChange={(checked) => {
              setVoiceEnabled(Boolean(checked));
              markChanged();
            }}
            aria-label={`${voiceEnabled ? "Disable" : "Enable"} voice calls for ${bot.name}`}
          />
        </div>

        <div className="space-y-2">
          <div className="text-sm font-medium">Tools</div>
          <button
            type="button"
            aria-label="Manage bot tools"
            aria-expanded={toolsOpen}
            onClick={() => setToolsOpen(true)}
            className="flex min-h-10 w-full items-center gap-3 rounded-lg border border-border bg-muted/20 px-3 text-left outline-none transition-colors hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring"
          >
            <AppIcon className="size-4 shrink-0 text-muted-foreground" icon={WrenchIcon} />
            <span className="min-w-0 flex-1 text-sm">
              {tools.length === 0
                ? "No workspace tools"
                : `${enabledToolCount} of ${tools.length} enabled`}
            </span>
            <span className="text-xs text-muted-foreground">Manage</span>
          </button>
        </div>

        <div className="space-y-2">
          <div className="text-sm font-medium">Channels</div>
          <button
            type="button"
            aria-label="Manage bot channels"
            aria-expanded={channelsOpen}
            onClick={() => setChannelsOpen(true)}
            className="flex min-h-10 w-full items-center gap-3 rounded-lg border border-border bg-muted/20 px-3 text-left outline-none transition-colors hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring"
          >
            <AppIcon className="size-4 shrink-0 text-muted-foreground" icon={Link02Icon} />
            <span className="min-w-0 flex-1 text-sm">
              {connectedChannelCount === 0 ? "No channels" : `${connectedChannelCount} connected`}
            </span>
            <span className="text-xs text-muted-foreground">Manage</span>
          </button>
        </div>
      </div>

      <div className="mt-7 flex items-center justify-end gap-3">
        {saved ? <span className="mr-auto text-xs text-success">Saved</span> : null}
        <Button
          size="sm"
          disabled={saving || !dirty || !name.trim() || !onSave}
          onClick={() => {
            if (!onSave) return;
            setSaving(true);
            void onSave({
              name: name.trim(),
              label: normalizedLabel,
              description: normalizedDescription,
              engine: nextEngine,
              sandbox: nextSandbox,
              voiceEnabled,
              disabledMcpServerIds,
            }).then((success) => {
              setSaving(false);
              setSaved(success);
              if (success) setEngineChanged(false);
            });
          }}
        >
          {saving ? "Saving" : "Save"}
        </Button>
      </div>

      <AvatarPickerDialog bot={bot} open={avatarOpen} onOpenChange={setAvatarOpen} />
      <BotToolsSheet
        open={toolsOpen}
        onOpenChange={setToolsOpen}
        servers={mcpServers}
        disabledIds={disabledMcpServerIds}
        onDisabledIdsChange={(ids) => {
          setDisabledMcpServerIds(ids);
          markChanged();
        }}
      />
      <BotChannelsSheet bot={bot} open={channelsOpen} onOpenChange={setChannelsOpen} />
    </div>
  );
}

export function BotDetailsPanel({
  bot,
  onSaveBot,
}: {
  readonly bot: Bot;
  readonly onSaveBot?: (input: BotProfileUpdate) => Promise<boolean>;
}) {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const [panelState, dispatchPanel] = useReducer(reduceBotDetailsPanelState, {
    desktopOpen: true,
    mobileOpen: false,
  });
  const shortcutLabel = shortcutLabelForCommand(keybindings, "rightPanel.toggle");

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat) return;
      if (
        event.target instanceof HTMLElement &&
        event.target.closest("[data-keybinding-capture]")
      ) {
        return;
      }
      if (resolveShortcutCommand(event, keybindings) !== "rightPanel.toggle") return;

      event.preventDefault();
      event.stopPropagation();
      dispatchPanel({
        type: window.matchMedia(RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY).matches
          ? "toggle-mobile"
          : "toggle-desktop",
      });
    };

    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [keybindings]);

  const content = (closeButton?: ReactNode) => (
    <>
      <header className="relative flex h-[var(--workspace-topbar-height)] shrink-0 items-center justify-center px-4">
        <h2 className="text-sm font-medium">Settings</h2>
        <div className="absolute right-3 flex items-center">{closeButton}</div>
      </header>
      <BotProfileEditor bot={bot} {...(onSaveBot ? { onSave: onSaveBot } : {})} />
    </>
  );

  return (
    <>
      <aside
        aria-hidden={!panelState.desktopOpen}
        aria-label={`${bot.name} bot sidebar`}
        data-testid="bot-details-panel"
        className={
          panelState.desktopOpen
            ? "hidden h-full w-88 shrink-0 flex-col border-l border-border bg-background min-[981px]:flex"
            : "hidden"
        }
      >
        {content(
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  aria-expanded="true"
                  aria-label={`Collapse ${bot.name} bot sidebar`}
                  size="icon-sm"
                  variant="ghost"
                  onClick={() => dispatchPanel({ type: "toggle-desktop" })}
                >
                  <AppIcon icon={PanelRightCloseIcon} />
                </Button>
              }
            />
            <TooltipPopup side="left">
              Collapse{shortcutLabel ? ` (${shortcutLabel})` : ""}
            </TooltipPopup>
          </Tooltip>,
        )}
      </aside>
      {!panelState.desktopOpen ? (
        <div className="fixed right-[var(--workspace-controls-right)] top-[var(--workspace-controls-top)] z-40 hidden h-[var(--workspace-topbar-height)] items-center min-[981px]:flex">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  aria-expanded="false"
                  aria-label={`Open ${bot.name} bot sidebar`}
                  size="icon-sm"
                  variant="ghost"
                  onClick={() => dispatchPanel({ type: "toggle-desktop" })}
                >
                  <AppIcon icon={PanelRightIcon} />
                </Button>
              }
            />
            <TooltipPopup side="left">
              Open sidebar{shortcutLabel ? ` (${shortcutLabel})` : ""}
            </TooltipPopup>
          </Tooltip>
        </div>
      ) : null}
      <div className="fixed right-[var(--workspace-controls-right)] top-[var(--workspace-controls-top)] z-40 flex h-[var(--workspace-topbar-height)] items-center min-[981px]:hidden">
        <Button
          aria-label={`Open ${bot.name} bot sidebar`}
          size="icon-sm"
          variant="ghost"
          onClick={() => dispatchPanel({ type: "set-mobile", open: true })}
        >
          <AppIcon icon={PanelRightIcon} />
        </Button>
      </div>
      <Sheet
        open={panelState.mobileOpen}
        onOpenChange={(open) => dispatchPanel({ type: "set-mobile", open })}
      >
        <SheetPopup
          className="w-[min(92vw,24rem)] pb-safe pt-safe p-0"
          showCloseButton={false}
          side="right"
        >
          <SheetTitle className="sr-only">Edit {bot.name}</SheetTitle>
          {content(
            <SheetClose
              aria-label="Close bot sidebar"
              render={<Button size="icon-sm" variant="ghost" />}
            >
              <AppIcon icon={Cancel01Icon} />
            </SheetClose>,
          )}
        </SheetPopup>
      </Sheet>
    </>
  );
}
