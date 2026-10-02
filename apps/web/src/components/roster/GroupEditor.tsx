import { Predicate } from "effect";
import { useAtomValue } from "@effect/atom-react";
import { BotId, GroupId, isGroupBotMember, type EnvironmentId } from "@akeru/contracts";
import { BotIcon, LogOutIcon, Trash2Icon } from "lucide-react";
import { useEffect, useId, useState } from "react";

import { useI18n } from "../../i18n";
import { ensureLocalApi } from "../../localApi";
import { botEnvironment, environmentPeopleAtom } from "../../state/bots";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { toastManager } from "../ui/toast";
import { GroupMemberStack } from "./GroupMemberStack";
import { groupBotMembers, groupContainsBot, groupPersonMembers } from "./roster.logic";
import type { Bot, Group } from "./types";
import { groupMemberRemovalHint, isGroupMemberRemovalBlocked } from "./groupMemberRemoval.logic";

export function GroupEditor({
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
  const { t, plural } = useI18n();

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

  const unassignPerson = useAtomCommand(botEnvironment.groups.unassignPerson, {
    reportFailure: false,
  });

  const leaveGroup = useAtomCommand(botEnvironment.groups.leave, { reportFailure: false });
  const currentPersonId = useAtomValue(environmentPeopleAtom(environmentId)).current?.id;
  const [name, setName] = useState(group.name);
  const [newMemberId, setNewMemberId] = useState("");
  const [busy, setBusy] = useState(false);
  const activeBots = bots.filter((bot) => bot.archivedAt === null);
  const members = groupBotMembers(group, activeBots);
  const people = groupPersonMembers(group);
  const availableBots = activeBots.filter((bot) => !groupContainsBot(group, bot.id));
  const removalHintId = useId();
  const addHintId = useId();

  const removalHint = groupMemberRemovalHint(
    {
      memberCount: members.length,
      bossName: members.find((bot) => bot.id === group.bossBotId)?.name ?? null,
      canAddBot: availableBots.length > 0,
    },
    t,
  );

  useEffect(() => setName(group.name), [group.name]);
  useEffect(() => {
    if (!availableBots.some((bot) => bot.id === newMemberId)) setNewMemberId("");
  }, [availableBots, newMemberId]);

  const run = async (action: () => Promise<{ readonly _tag: string }>, failure: string) => {
    setBusy(true);
    const result = await action();
    setBusy(false);

    if (Predicate.isTagged(result, "Failure")) {
      toastManager.add({ type: "error", title: failure });

      return false;
    }

    return true;
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6">
      <div className="flex flex-col items-center gap-3 pb-7 pt-6">
        <GroupMemberStack group={group} bots={bots} sizeClassName="size-16" />
        <span className="text-sm text-muted-foreground">
          {plural(members.length, { one: "{count} bot", other: "{count} bots" })}
        </span>
      </div>
      <div className="space-y-5">
        <label className="block space-y-2 text-sm font-medium">
          {t("Name")}
          <div className="flex gap-2">
            <Input
              aria-label={t("Group name")}
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
                  t("Could not rename group"),
                )
              }
            >
              {t("Save")}
            </Button>
          </div>
        </label>
        <label className="block space-y-2 text-sm font-medium">
          {t("Boss")}
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
                t("Could not change group boss"),
              );
            }}
          >
            <SelectTrigger aria-label={t("Group boss")} className="w-full">
              <SelectValue>
                {members.find((bot) => bot.id === group.bossBotId)?.name ?? t("Choose boss")}
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
            {t("Bots")}
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
                    {role?.kind === "bot" && role.role === "boss" ? t("Boss") : t("Specialist")}
                  </span>
                  <Button
                    aria-describedby={removalHint && blockedByRule ? removalHintId : undefined}
                    aria-label={t("Remove {bot} from {group}", {
                      bot: bot.name,
                      group: group.name,
                    })}
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
                        t("Could not remove {name}", { name: bot.name }),
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
                aria-label={t("Add bot")}
                aria-describedby={availableBots.length === 0 ? addHintId : undefined}
                className="min-w-0 flex-1"
              >
                <SelectValue placeholder={t("Choose bot")} />
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
              aria-label={t("Add bot to group")}
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
                  t("Could not add bot"),
                ).then((success) => success && setNewMemberId(""))
              }
            >
              <BotIcon />
            </Button>
          </div>
          {availableBots.length === 0 ? (
            <p id={addHintId} className="text-xs text-muted-foreground">
              {t("Every bot is already in this group.")}
            </p>
          ) : null}
        </section>
        {people.length > 0 ? (
          <section className="space-y-2" aria-labelledby="group-people-heading">
            <h3 id="group-people-heading" className="text-sm font-medium">
              People
            </h3>
            <div className="space-y-1 rounded-lg border p-2">
              {people.map((person) => {
                const current = person.personId === currentPersonId;

                return (
                  <div
                    key={person.personId}
                    className="flex min-h-9 items-center gap-2 rounded-md px-1"
                  >
                    <span className="min-w-0 flex-1 truncate text-sm">
                      {current ? "You" : person.displayName}
                    </span>
                    <Button
                      aria-label={
                        current
                          ? `Leave ${group.name}`
                          : `Remove ${person.displayName} from ${group.name}`
                      }
                      disabled={busy}
                      size="icon-sm"
                      variant="ghost"
                      onClick={() =>
                        void run(
                          () =>
                            current
                              ? leaveGroup({
                                  environmentId,
                                  input: {
                                    groupId: GroupId.make(group.id),
                                    personId: person.personId,
                                  },
                                })
                              : unassignPerson({
                                  environmentId,
                                  input: {
                                    groupId: GroupId.make(group.id),
                                    personId: person.personId,
                                  },
                                }),
                          current
                            ? "Could not leave group"
                            : `Could not remove ${person.displayName}`,
                        )
                      }
                    >
                      {current ? <LogOutIcon /> : <Trash2Icon />}
                    </Button>
                  </div>
                );
              })}
            </div>
          </section>
        ) : null}
      </div>
      <Button
        className="mt-6 w-full"
        disabled={busy}
        variant="destructive-outline"
        onClick={async () => {
          const confirmed = await ensureLocalApi().dialogs.confirm(
            t('Delete "{name}"? Its bots stay in your roster.', { name: group.name }),
            { variant: "destructive", confirmLabel: t("Delete group") },
          );

          if (!confirmed) return;

          const success = await run(
            () =>
              deleteGroup({
                environmentId,
                input: { groupId: GroupId.make(group.id) },
              }),
            t("Could not delete group"),
          );

          if (success) onDeleted();
        }}
      >
        {t("Delete group")}
      </Button>
    </div>
  );
}
