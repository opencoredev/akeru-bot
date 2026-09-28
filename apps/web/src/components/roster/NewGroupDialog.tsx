import { useEffect, useMemo, useState } from "react";

import { useI18n } from "../../i18n";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { BotAvatarView } from "./BotAvatarView";
import type { Bot } from "./types";

export interface NewGroupInput {
  readonly name: string;
  readonly bossBotId: string;
  readonly specialistBotIds: readonly string[];
}

export function canCreateGroup(
  name: string,
  selectedIds: readonly string[],
  bossBotId: string,
): boolean {
  return (
    name.trim().length > 0 && new Set(selectedIds).size >= 2 && selectedIds.includes(bossBotId)
  );
}

/** Hint shown under the bot list until the group has enough members. */
export function groupSelectionHint(selectedIds: readonly string[]): string | null {
  return new Set(selectedIds).size >= 2 ? null : "Select at least two bots.";
}

export function NewGroupDialog({
  open,
  bots,
  onOpenChange,
  onCreate,
}: {
  readonly open: boolean;
  readonly bots: readonly Bot[];
  readonly onOpenChange: (open: boolean) => void;
  readonly onCreate: (input: NewGroupInput) => void;
}) {
  const { t } = useI18n();
  const activeBots = useMemo(() => bots.filter((bot) => bot.archivedAt === null), [bots]);
  const [name, setName] = useState("");
  const [selectedIds, setSelectedIds] = useState<readonly string[]>(() =>
    activeBots.slice(0, 2).map((bot) => bot.id),
  );
  const [bossBotId, setBossBotId] = useState(selectedIds[0] ?? "");
  const selectedBots = activeBots.filter((bot) => selectedIds.includes(bot.id));
  const selectionHint = groupSelectionHint(selectedIds);

  useEffect(() => {
    if (!selectedIds.includes(bossBotId)) setBossBotId(selectedIds[0] ?? "");
  }, [bossBotId, selectedIds]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup
        className="flex max-h-[calc(100dvh-2rem)] max-w-lg flex-col overflow-hidden"
        bottomStickOnMobile={false}
      >
        <form
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            if (!canCreateGroup(name, selectedIds, bossBotId)) return;
            onCreate({
              name: name.trim(),
              bossBotId,
              specialistBotIds: selectedIds.filter((id) => id !== bossBotId),
            });
          }}
        >
          <DialogHeader className="shrink-0">
            <DialogTitle>{t("New group")}</DialogTitle>
            <DialogDescription>
              Choose the bots in this group and which one leads.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-5">
            <label className="block space-y-2 text-sm font-medium">
              {t("Name")}
              <Input
                autoFocus
                aria-label={t("Group name")}
                maxLength={80}
                placeholder={t("Group name")}
                value={name}
                onChange={(event) => setName(event.currentTarget.value)}
              />
            </label>
            <fieldset className="space-y-2">
              <legend className="mb-2 text-sm font-medium">{t("Bots")}</legend>
              <div className="max-h-56 space-y-1 overflow-y-auto rounded-lg border p-2">
                {activeBots.map((bot) => {
                  const checked = selectedIds.includes(bot.id);
                  return (
                    <label
                      key={bot.id}
                      className="flex min-h-10 cursor-pointer items-center gap-3 rounded-md px-2 hover:bg-muted/50"
                    >
                      <Checkbox
                        checked={checked}
                        onCheckedChange={(next) =>
                          setSelectedIds((current) =>
                            next
                              ? [...current, bot.id]
                              : current.filter((candidate) => candidate !== bot.id),
                          )
                        }
                      />
                      <BotAvatarView avatar={bot.avatar} name={bot.name} className="size-7" />
                      <span className="min-w-0 flex-1 truncate text-sm">{bot.name}</span>
                    </label>
                  );
                })}
              </div>
              {selectionHint ? (
                <p className="text-xs text-muted-foreground">{selectionHint}</p>
              ) : null}
            </fieldset>
            <label className="block space-y-2 text-sm font-medium">
              {t("Boss")}
              <Select value={bossBotId} onValueChange={(value) => value && setBossBotId(value)}>
                <SelectTrigger aria-label={t("Group boss")} className="w-full">
                  <SelectValue>
                    {selectedBots.find((bot) => bot.id === bossBotId)?.name ?? t("Choose boss")}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {selectedBots.map((bot) => (
                    <SelectItem key={bot.id} value={bot.id}>
                      {bot.name}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </label>
          </DialogPanel>
          <DialogFooter className="shrink-0">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              {t("Cancel")}
            </Button>
            <Button type="submit" disabled={!canCreateGroup(name, selectedIds, bossBotId)}>
              {t("Create group")}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
