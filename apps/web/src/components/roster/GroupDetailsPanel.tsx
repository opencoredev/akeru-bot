import { useAtomValue } from "@effect/atom-react";
import { BotId, GroupId, isGroupBotMember, type EnvironmentId } from "@t3tools/contracts";
import { Cancel01Icon, PanelRightCloseIcon, PanelRightIcon } from "@hugeicons/core-free-icons";
import { BotIcon, Trash2Icon } from "lucide-react";
import { useEffect, useId, useReducer, useState, type ReactNode } from "react";

import { resolveShortcutCommand, shortcutLabelForCommand } from "../../keybindings";
import { ensureLocalApi } from "../../localApi";
import { RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY } from "../../rightPanelLayout";
import { botEnvironment } from "../../state/bots";
import { useAtomCommand } from "../../state/use-atom-command";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { SettingsRow } from "../settings/settingsLayout";
import { AppIcon } from "../ui/app-icon";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Sheet, SheetClose, SheetPopup, SheetTitle } from "../ui/sheet";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { GroupMemberStack } from "./GroupMemberStack";
import { groupBotMembers, groupContainsBot } from "./roster.logic";
import type { Bot, Group } from "./types";

type PanelState = {
  readonly desktopOpen: boolean;
  readonly mobileOpen: boolean;
};
type PanelAction =
  | { readonly type: "toggle-desktop" }
  | { readonly type: "toggle-mobile" }
  | { readonly type: "set-mobile"; readonly open: boolean };

function reducePanelState(state: PanelState, action: PanelAction): PanelState {
  if (action.type === "toggle-desktop") return { ...state, desktopOpen: !state.desktopOpen };
  if (action.type === "toggle-mobile") return { ...state, mobileOpen: !state.mobileOpen };
  return { ...state, mobileOpen: action.open };
}

/**
 * Explains why the member list blocks removal, so the way back out of a group
 * change is always visible. Returns null when every specialist can be removed.
 */
export function groupMemberRemovalHint(input: {
  readonly memberCount: number;
  readonly bossName: string | null;
  readonly canAddBot: boolean;
}): string | null {
  if (input.memberCount <= 2) {
    return input.canAddBot
      ? "A group needs at least two bots. Add another bot before you remove one."
      : "A group needs at least two bots. Create a new bot in the roster before you remove one.";
  }
  if (input.bossName !== null) {
    return `To remove ${input.bossName}, make another bot the boss first.`;
  }
  return null;
}

/** True when the removal hint explains why this row's remove button is disabled. */
export function isGroupMemberRemovalBlocked(input: {
  readonly memberCount: number;
  readonly isBoss: boolean;
}): boolean {
  return input.memberCount <= 2 || input.isBoss;
}

function GroupEditor({
  environmentId,
  group,
  bots,
  onDeleted,
}: {
  readonly environmentId: EnvironmentId;
  readonly group: Group;
  readonly bots: readonly Bot[];
  readonly onDeleted: () => void;
}) {
  const renameGroup = useAtomCommand(botEnvironment.groups.rename, {
    reportFailure: false,
  });
  const deleteGroup = useAtomCommand(botEnvironment.groups.delete, {
    reportFailure: false,
  });
  const assignMember = useAtomCommand(botEnvironment.groups.assignMember, {
    reportFailure: false,
  });
  const unassignMember = useAtomCommand(botEnvironment.groups.unassignMember, {
    reportFailure: false,
  });
  const setBoss = useAtomCommand(botEnvironment.groups.setBoss, {
    reportFailure: false,
  });
  const [name, setName] = useState(group.name);
  const [newMemberId, setNewMemberId] = useState("");
  const [busy, setBusy] = useState(false);
  const activeBots = bots.filter((bot) => bot.archivedAt === null);
  const members = groupBotMembers(group, activeBots);
  const availableBots = activeBots.filter((bot) => !groupContainsBot(group, bot.id));
  const removalHintId = useId();
  const addHintId = useId();
  const removalHint = groupMemberRemovalHint({
    memberCount: members.length,
    bossName: members.find((bot) => bot.id === group.bossBotId)?.name ?? null,
    canAddBot: availableBots.length > 0,
  });

  useEffect(() => setName(group.name), [group.name]);
  useEffect(() => {
    if (!availableBots.some((bot) => bot.id === newMemberId)) setNewMemberId("");
  }, [availableBots, newMemberId]);

  const run = async (action: () => Promise<{ readonly _tag: string }>, failure: string) => {
    setBusy(true);
    const result = await action();
    setBusy(false);
    if (result._tag === "Failure") {
      toastManager.add({ type: "error", title: failure });
      return false;
    }
    return true;
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6">
      <div className="flex flex-col items-center gap-3 pb-7 pt-6">
        <GroupMemberStack group={group} bots={bots} sizeClassName="size-16" />
        <span className="text-sm text-muted-foreground">{members.length} bots</span>
      </div>
      <div className="space-y-5">
        <label className="block space-y-2 text-sm font-medium">
          Name
          <div className="flex gap-2">
            <Input
              aria-label="Group name"
              className="w-0 min-w-0 flex-1"
              value={name}
              onChange={(event) => setName(event.currentTarget.value)}
            />
            <Button
              size="sm"
              disabled={busy || !name.trim() || name.trim() === group.name}
              onClick={() =>
                void run(
                  () =>
                    renameGroup({
                      environmentId,
                      input: {
                        groupId: GroupId.make(group.id),
                        name: name.trim(),
                      },
                    }),
                  "Could not rename group",
                )
              }
            >
              Save
            </Button>
          </div>
        </label>
        <label className="block space-y-2 text-sm font-medium">
          Boss
          <Select
            value={group.bossBotId ?? ""}
            onValueChange={(botId) => {
              if (!botId || botId === group.bossBotId) return;
              void run(
                () =>
                  setBoss({
                    environmentId,
                    input: {
                      groupId: GroupId.make(group.id),
                      bossBotId: BotId.make(botId),
                      unassignPreviousBoss: false,
                    },
                  }),
                "Could not change group boss",
              );
            }}
          >
            <SelectTrigger aria-label="Group boss" className="w-full">
              <SelectValue>
                {members.find((bot) => bot.id === group.bossBotId)?.name ?? "Choose boss"}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {members.map((bot) => (
                <SelectItem key={bot.id} value={bot.id}>
                  {bot.name}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </label>
        <section className="space-y-2" aria-labelledby="group-bots-heading">
          <h3 id="group-bots-heading" className="text-sm font-medium">
            Bots
          </h3>
          <div className="space-y-1 rounded-lg border p-2">
            {members.map((bot) => {
              const role = group.members.find(
                (member) => isGroupBotMember(member) && member.botId === bot.id,
              );
              const blockedByRule = isGroupMemberRemovalBlocked({
                memberCount: members.length,
                isBoss: role?.kind === "bot" && role.role === "boss",
              });
              return (
                <div key={bot.id} className="flex min-h-9 items-center gap-2 rounded-md px-1">
                  <span className="min-w-0 flex-1 truncate text-sm">{bot.name}</span>
                  <span className="text-xs capitalize text-muted-foreground">
                    {role?.kind === "bot" ? role.role : "specialist"}
                  </span>
                  <Button
                    aria-describedby={removalHint && blockedByRule ? removalHintId : undefined}
                    aria-label={`Remove ${bot.name} from ${group.name}`}
                    disabled={busy || role?.kind !== "bot" || blockedByRule}
                    size="icon-sm"
                    variant="ghost"
                    onClick={() =>
                      void run(
                        () =>
                          unassignMember({
                            environmentId,
                            input: {
                              groupId: GroupId.make(group.id),
                              botId: BotId.make(bot.id),
                            },
                          }),
                        `Could not remove ${bot.name}`,
                      )
                    }
                  >
                    <Trash2Icon />
                  </Button>
                </div>
              );
            })}
          </div>
          {removalHint ? (
            <p id={removalHintId} className="text-xs text-muted-foreground">
              {removalHint}
            </p>
          ) : null}
          <div className="flex gap-2">
            <Select
              disabled={availableBots.length === 0}
              value={newMemberId}
              onValueChange={(value) => value && setNewMemberId(value)}
            >
              <SelectTrigger
                aria-label="Add bot"
                aria-describedby={availableBots.length === 0 ? addHintId : undefined}
                className="min-w-0 flex-1"
              >
                <SelectValue placeholder="Choose bot" />
              </SelectTrigger>
              <SelectPopup>
                {availableBots.map((bot) => (
                  <SelectItem key={bot.id} value={bot.id}>
                    {bot.name}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            <Button
              aria-label="Add bot to group"
              disabled={busy || !newMemberId}
              size="icon"
              variant="outline"
              onClick={() =>
                void run(
                  () =>
                    assignMember({
                      environmentId,
                      input: {
                        groupId: GroupId.make(group.id),
                        botId: BotId.make(newMemberId),
                        role: "specialist",
                      },
                    }),
                  "Could not add bot",
                ).then((success) => success && setNewMemberId(""))
              }
            >
              <BotIcon />
            </Button>
          </div>
          {availableBots.length === 0 ? (
            <p id={addHintId} className="text-xs text-muted-foreground">
              Every bot is already in this group.
            </p>
          ) : null}
        </section>
      </div>
      <div className="mt-6 -mx-2">
        <SettingsRow
          title="Delete group"
          control={
            <Button
              disabled={busy}
              variant="destructive"
              onClick={async () => {
                const confirmed = await ensureLocalApi().dialogs.confirm(
                  `Delete "${group.name}"? Its bots stay in your roster.`,
                  { variant: "destructive" },
                );
                if (!confirmed) return;
                const success = await run(
                  () =>
                    deleteGroup({
                      environmentId,
                      input: { groupId: GroupId.make(group.id) },
                    }),
                  "Could not delete group",
                );
                if (success) onDeleted();
              }}
            >
              Delete
            </Button>
          }
        />
      </div>
    </div>
  );
}

export function GroupDetailsPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly group: Group;
  readonly bots: readonly Bot[];
  readonly onDeleted: () => void;
}) {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const [panelState, dispatchPanel] = useReducer(reducePanelState, {
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
        <h2 className="text-sm font-medium">Group</h2>
        <div className="absolute right-3 flex items-center min-[981px]:fixed min-[981px]:right-[var(--workspace-controls-right)] min-[981px]:top-[var(--workspace-controls-top)] min-[981px]:z-40 min-[981px]:h-[var(--workspace-topbar-height)]">
          {closeButton}
        </div>
      </header>
      <GroupEditor {...props} />
    </>
  );

  return (
    <>
      <aside
        aria-hidden={!panelState.desktopOpen}
        aria-label={`${props.group.name} group sidebar`}
        data-testid="group-details-panel"
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
                  aria-label={`Collapse ${props.group.name} group sidebar`}
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
          <Button
            aria-label={`Open ${props.group.name} group sidebar`}
            size="icon-sm"
            variant="ghost"
            onClick={() => dispatchPanel({ type: "toggle-desktop" })}
          >
            <AppIcon icon={PanelRightIcon} />
          </Button>
        </div>
      ) : null}
      <div className="fixed right-[var(--workspace-controls-right)] top-[var(--workspace-controls-top)] z-40 flex h-[var(--workspace-topbar-height)] items-center min-[981px]:hidden">
        <Button
          aria-label={`Open ${props.group.name} group sidebar`}
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
          <SheetTitle className="sr-only">Edit {props.group.name}</SheetTitle>
          {content(
            <SheetClose
              aria-label="Close group sidebar"
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
