import {
  type AuthClientSession,
  type AuthSessionId,
  type EnvironmentId,
  type OrchestrationGroup,
} from "@t3tools/contracts";
import { LogOutIcon, Trash2Icon, UserPlusIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { botEnvironment } from "../../state/bots";
import { useAtomCommand } from "../../state/use-atom-command";
import { openSettings } from "../../settingsDialogStore";
import { groupPersonMembers } from "../roster/roster.logic";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { toastManager } from "../ui/toast";
import { SettingsRow } from "./settingsLayout";

export function GroupPeopleSettings({
  environmentId,
  group,
  people,
  currentPersonId,
}: {
  readonly environmentId: EnvironmentId;
  readonly group: OrchestrationGroup;
  readonly people: ReadonlyArray<AuthClientSession>;
  readonly currentPersonId: AuthSessionId | null;
}) {
  const assignPerson = useAtomCommand(botEnvironment.groups.assignPerson, {
    reportFailure: false,
  });
  const unassignPerson = useAtomCommand(botEnvironment.groups.unassignPerson, {
    reportFailure: false,
  });
  const leaveGroup = useAtomCommand(botEnvironment.groups.leave, { reportFailure: false });
  const [personId, setPersonId] = useState("");
  const [busy, setBusy] = useState(false);
  const members = useMemo(() => groupPersonMembers(group), [group]);
  const availablePeople = useMemo(
    () =>
      people.filter((person) => !members.some((member) => member.personId === person.sessionId)),
    [members, people],
  );

  useEffect(() => {
    if (!availablePeople.some((person) => person.sessionId === personId)) setPersonId("");
  }, [availablePeople, personId]);

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
    <>
      <div className="space-y-1 px-3 pb-3 sm:px-4">
        {members.map((person) => (
          <div key={person.personId} className="flex min-h-10 items-center gap-3 rounded-lg px-2">
            <span className="flex size-7 items-center justify-center rounded-full bg-muted text-xs font-semibold">
              {person.displayName.slice(0, 1).toUpperCase()}
            </span>
            <span className="min-w-0 flex-1 truncate text-sm">
              {person.personId === currentPersonId ? "You" : person.displayName}
            </span>
            {person.personId !== currentPersonId ? (
              <Button
                aria-label={`Remove ${person.displayName} from ${group.name}`}
                disabled={busy}
                size="icon-sm"
                variant="ghost"
                onClick={() =>
                  void run(
                    () =>
                      unassignPerson({
                        environmentId,
                        input: { groupId: group.id, personId: person.personId },
                      }),
                    `Could not remove ${person.displayName}`,
                  )
                }
              >
                <Trash2Icon />
              </Button>
            ) : null}
          </div>
        ))}
      </div>
      <SettingsRow
        title="Add person"
        description={
          availablePeople.length === 0
            ? "Pair another client in Connections before adding a person."
            : undefined
        }
        control={
          <div className="flex items-center gap-2">
            <Select value={personId} onValueChange={(value) => value && setPersonId(value)}>
              <SelectTrigger aria-label="Person" className="w-44">
                <SelectValue placeholder="Choose person" />
              </SelectTrigger>
              <SelectPopup>
                {availablePeople.map((person) => (
                  <SelectItem key={person.sessionId} value={person.sessionId}>
                    {person.client.label ?? "Paired person"}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            <Button
              aria-label="Add person"
              disabled={busy || !personId}
              size="icon-sm"
              variant="outline"
              onClick={() => {
                const person = availablePeople.find(
                  (candidate) => candidate.sessionId === personId,
                );
                if (!person) return;
                void run(
                  () =>
                    assignPerson({
                      environmentId,
                      input: {
                        groupId: group.id,
                        person: {
                          kind: "person",
                          personId: person.sessionId,
                          displayName: person.client.label ?? "Paired person",
                        },
                      },
                    }),
                  "Could not add person",
                ).then((success) => success && setPersonId(""));
              }}
            >
              <UserPlusIcon />
            </Button>
          </div>
        }
      />
      <SettingsRow
        title="Invite people"
        description="Pair another client in Connections."
        control={
          <Button variant="outline" onClick={() => openSettings("connections")}>
            Open Connections
          </Button>
        }
      />
      {currentPersonId && members.some((person) => person.personId === currentPersonId) ? (
        <SettingsRow
          title="Leave group"
          control={
            <Button
              disabled={busy}
              variant="outline"
              onClick={() =>
                void run(
                  () =>
                    leaveGroup({
                      environmentId,
                      input: { groupId: group.id, personId: currentPersonId },
                    }),
                  "Could not leave group",
                )
              }
            >
              <LogOutIcon />
              Leave
            </Button>
          }
        />
      ) : null}
    </>
  );
}
