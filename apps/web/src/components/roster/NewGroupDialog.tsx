import { useEffect, useMemo, useState } from "react";

import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Dialog, DialogPopup, DialogTitle } from "../ui/dialog";
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
  const activeBots = useMemo(() => bots.filter((bot) => bot.archivedAt === null), [bots]);
  const [name, setName] = useState("");
  const [selectedIds, setSelectedIds] = useState<readonly string[]>(() =>
    activeBots.slice(0, 2).map((bot) => bot.id),
  );
  const [bossBotId, setBossBotId] = useState(selectedIds[0] ?? "");
  const selectedBots = activeBots.filter((bot) => selectedIds.includes(bot.id));

  useEffect(() => {
    if (!selectedIds.includes(bossBotId)) setBossBotId(selectedIds[0] ?? "");
  }, [bossBotId, selectedIds]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-lg overflow-hidden p-0" bottomStickOnMobile={false}>
        <form
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
          <header className="border-b px-6 py-5">
            <DialogTitle>New group</DialogTitle>
          </header>
          <div className="space-y-5 px-6 py-6">
            <label className="block space-y-2 text-sm font-medium">
              Name
              <Input
                autoFocus
                aria-label="Group name"
                maxLength={80}
                placeholder="Group name"
                value={name}
                onChange={(event) => setName(event.currentTarget.value)}
              />
            </label>
            <fieldset className="space-y-2">
              <legend className="mb-2 text-sm font-medium">Bots</legend>
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
              <p className="text-xs text-muted-foreground">Select at least two bots.</p>
            </fieldset>
            <label className="block space-y-2 text-sm font-medium">
              Boss
              <Select value={bossBotId} onValueChange={(value) => value && setBossBotId(value)}>
                <SelectTrigger aria-label="Group boss" className="w-full">
                  <SelectValue>
                    {selectedBots.find((bot) => bot.id === bossBotId)?.name ?? "Choose boss"}
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
          </div>
          <footer className="flex justify-end gap-2 border-t bg-muted px-6 py-4">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canCreateGroup(name, selectedIds, bossBotId)}>
              Create group
            </Button>
          </footer>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
