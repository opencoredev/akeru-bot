import { useAtomValue } from "@effect/atom-react";
import {
  AuthSessionId,
  BotId,
  GROUP_SHARED_WORKSPACE_WARNING,
  GroupId,
  isGroupBotMember,
  type AuthClientSession,
  type EnvironmentId,
  type OrchestrationBot,
  type OrchestrationGroup,
} from "@t3tools/contracts";
import { Trash2Icon, UserPlusIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { randomUUID } from "../../lib/utils";
import { authEnvironment } from "../../state/auth";
import {
  botEnvironment,
  environmentBotsAtom,
  environmentGroupsAtom,
  environmentPeopleAtom,
} from "../../state/bots";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { toastManager } from "../ui/toast";
import { GroupPeopleSettings } from "./GroupPeopleSettings";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

export function availableSpecialists(
  bots: ReadonlyArray<Pick<OrchestrationBot, "id" | "name" | "archivedAt">>,
  group?: Pick<OrchestrationGroup, "members"> | null,
): ReadonlyArray<Pick<OrchestrationBot, "id" | "name" | "archivedAt">> {
  return bots.filter(
    (bot) =>
      bot.archivedAt === null &&
      !group?.members.some((member) => isGroupBotMember(member) && member.botId === bot.id),
  );
}

const NO_ENVIRONMENT = "" as EnvironmentId;

export function GroupSettingsSection({
  environmentId,
  bots,
  groups,
  people,
  currentPersonId,
}: {
  readonly environmentId: EnvironmentId;
  readonly bots: ReadonlyArray<OrchestrationBot>;
  readonly groups: ReadonlyArray<OrchestrationGroup>;
  readonly people: ReadonlyArray<AuthClientSession>;
  readonly currentPersonId: AuthSessionId | null;
}) {
  const createGroup = useAtomCommand(botEnvironment.groups.create, { reportFailure: false });
  const deleteGroup = useAtomCommand(botEnvironment.groups.delete, { reportFailure: false });
  const assignMember = useAtomCommand(botEnvironment.groups.assignMember, {
    reportFailure: false,
  });
  const unassignMember = useAtomCommand(botEnvironment.groups.unassignMember, {
    reportFailure: false,
  });
  const setBoss = useAtomCommand(botEnvironment.groups.setBoss, { reportFailure: false });
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(groups[0]?.id ?? null);
  const [newGroupName, setNewGroupName] = useState("");
  const [newBossId, setNewBossId] = useState<string>(
    bots.find((bot) => bot.archivedAt === null)?.id ?? "",
  );
  const [specialistId, setSpecialistId] = useState("");
  const [busy, setBusy] = useState(false);
  const selectedGroup = groups.find((group) => group.id === selectedGroupId) ?? groups[0] ?? null;
  const activeBots = useMemo(() => availableSpecialists(bots), [bots]);
  const unassignedBots = useMemo(
    () => availableSpecialists(bots, selectedGroup),
    [bots, selectedGroup],
  );
  const members = selectedGroup
    ? selectedGroup.members.flatMap((membership) => {
        if (!isGroupBotMember(membership)) return [];
        const bot = bots.find((candidate) => candidate.id === membership.botId);
        return bot ? [{ bot, role: membership.role }] : [];
      })
    : [];

  useEffect(() => {
    if (selectedGroup && selectedGroup.id !== selectedGroupId) {
      setSelectedGroupId(selectedGroup.id);
    }
  }, [selectedGroup, selectedGroupId]);

  useEffect(() => {
    if (!activeBots.some((bot) => bot.id === newBossId)) {
      setNewBossId(activeBots[0]?.id ?? "");
    }
    if (!unassignedBots.some((bot) => bot.id === specialistId)) {
      setSpecialistId("");
    }
  }, [activeBots, newBossId, specialistId, unassignedBots]);

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

  const create = async () => {
    const name = newGroupName.trim();
    if (!name || !newBossId) return;
    const groupId = GroupId.make(`group-${randomUUID()}`);
    if (
      await run(
        () =>
          createGroup({
            environmentId,
            input: { groupId, name, bossBotId: BotId.make(newBossId) },
          }),
        "Could not create group",
      )
    ) {
      setSelectedGroupId(groupId);
      setNewGroupName("");
    }
  };

  return (
    <SettingsSection title="Groups">
      <div className="mx-3 mb-3 rounded-lg border border-warning/30 bg-warning/8 px-3 py-2 text-xs leading-5 text-muted-foreground sm:mx-4">
        {GROUP_SHARED_WORKSPACE_WARNING}
      </div>
      <SettingsRow
        title="New group"
        description="Choose one boss. Specialists can be added after creation."
        control={
          <div className="flex w-72 flex-col gap-2">
            <Input
              aria-label="New group name"
              placeholder="Group name"
              value={newGroupName}
              onChange={(event) => setNewGroupName(event.currentTarget.value)}
            />
            <Select value={newBossId} onValueChange={(value) => value && setNewBossId(value)}>
              <SelectTrigger aria-label="New group boss" className="w-full">
                <SelectValue placeholder="Choose boss" />
              </SelectTrigger>
              <SelectPopup>
                {activeBots.map((bot) => (
                  <SelectItem key={bot.id} value={bot.id}>
                    {bot.name}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            <Button
              disabled={busy || !newGroupName.trim() || !newBossId}
              onClick={() => void create()}
            >
              Create group
            </Button>
          </div>
        }
      />
      {selectedGroup ? (
        <>
          <SettingsRow
            title="Manage group"
            control={
              <Select
                value={selectedGroup.id}
                onValueChange={(value) => value && setSelectedGroupId(value)}
              >
                <SelectTrigger aria-label="Group" className="w-52">
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  {groups.map((group) => (
                    <SelectItem key={group.id} value={group.id}>
                      {group.name}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            }
          />
          <SettingsRow
            title="Boss"
            description="Changing the boss keeps the previous boss as a specialist."
            control={
              <Select
                value={selectedGroup.bossBotId ?? ""}
                onValueChange={(botId) => {
                  if (!botId || botId === selectedGroup.bossBotId) return;
                  void run(
                    () =>
                      setBoss({
                        environmentId,
                        input: {
                          groupId: selectedGroup.id,
                          bossBotId: BotId.make(botId),
                          unassignPreviousBoss: false,
                        },
                      }),
                    "Could not change group boss",
                  );
                }}
              >
                <SelectTrigger aria-label="Group boss" className="w-52">
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  {activeBots.map((bot) => (
                    <SelectItem key={bot.id} value={bot.id}>
                      {bot.name}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            }
          />
          <div className="space-y-1 px-3 pb-3 sm:px-4">
            {members.map(({ bot, role }) => (
              <div key={bot.id} className="flex min-h-10 items-center gap-3 rounded-lg px-2">
                <span className="min-w-0 flex-1 truncate text-sm">{bot.name}</span>
                <span className="text-xs capitalize text-muted-foreground">{role}</span>
                <Button
                  aria-label={`Remove ${bot.name} from ${selectedGroup.name}`}
                  disabled={busy || role === "boss"}
                  size="icon-sm"
                  variant="ghost"
                  onClick={() =>
                    void run(
                      () =>
                        unassignMember({
                          environmentId,
                          input: { groupId: selectedGroup.id, botId: BotId.make(bot.id) },
                        }),
                      `Could not remove ${bot.name}`,
                    )
                  }
                >
                  <Trash2Icon />
                </Button>
              </div>
            ))}
          </div>
          <SettingsRow
            title="Add specialist"
            control={
              <div className="flex items-center gap-2">
                <Select
                  value={specialistId}
                  onValueChange={(value) => value && setSpecialistId(value)}
                >
                  <SelectTrigger aria-label="Specialist" className="w-44">
                    <SelectValue placeholder="Choose bot" />
                  </SelectTrigger>
                  <SelectPopup>
                    {unassignedBots.map((bot) => (
                      <SelectItem key={bot.id} value={bot.id}>
                        {bot.name}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
                <Button
                  aria-label="Add specialist"
                  disabled={busy || !specialistId}
                  size="icon-sm"
                  variant="outline"
                  onClick={() => {
                    if (!specialistId) return;
                    void run(
                      () =>
                        assignMember({
                          environmentId,
                          input: {
                            groupId: selectedGroup.id,
                            botId: BotId.make(specialistId),
                            role: "specialist",
                          },
                        }),
                      "Could not add specialist",
                    ).then((success) => success && setSpecialistId(""));
                  }}
                >
                  <UserPlusIcon />
                </Button>
              </div>
            }
          />
          <SettingsRow
            title="Delete group"
            description="Threads lose their group owner."
            control={
              <Button
                disabled={busy}
                variant="destructive"
                onClick={() =>
                  void run(
                    () => deleteGroup({ environmentId, input: { groupId: selectedGroup.id } }),
                    "Could not delete group",
                  )
                }
              >
                Delete group
              </Button>
            }
          />
          <GroupPeopleSettings
            environmentId={environmentId}
            group={selectedGroup}
            people={people}
            currentPersonId={currentPersonId}
          />
        </>
      ) : null}
    </SettingsSection>
  );
}

export function GroupSettingsPanel() {
  const environmentId = usePrimaryEnvironmentId();
  const atomKey = environmentId ?? NO_ENVIRONMENT;
  const bots = useAtomValue(environmentBotsAtom(atomKey));
  const groups = useAtomValue(environmentGroupsAtom(atomKey));
  const currentPerson = useAtomValue(environmentPeopleAtom(atomKey)).current;
  const accessChanges = useEnvironmentQuery(
    environmentId === null ? null : authEnvironment.accessChanges({ environmentId, input: null }),
  );
  const people =
    accessChanges.data?.type === "snapshot" ? accessChanges.data.payload.clientSessions : [];
  return (
    <SettingsPageContainer>
      {environmentId === null ? (
        <div className="px-4 py-8 text-sm text-muted-foreground">Connect an environment first.</div>
      ) : (
        <GroupSettingsSection
          environmentId={environmentId}
          bots={bots}
          groups={groups}
          people={people}
          currentPersonId={currentPerson?.id ?? null}
        />
      )}
    </SettingsPageContainer>
  );
}
