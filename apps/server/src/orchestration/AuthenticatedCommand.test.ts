import {
  AuthSessionId,
  BotId,
  CommandId,
  GroupId,
  MessageId,
  ThreadId,
  type AuthClientSession,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  applyAuthenticatedCommandActor,
  applyKnownGroupPerson,
  canManageGroupPeople,
} from "./AuthenticatedCommand.ts";

const currentPersonId = AuthSessionId.make("person-current");
const targetPersonId = AuthSessionId.make("person-target");

const targetSession = {
  sessionId: targetPersonId,
  client: { label: "Target person" },
} as AuthClientSession;

describe("authenticated orchestration commands", () => {
  it("replaces spoofed leave identity with the authenticated person", () => {
    const command = applyAuthenticatedCommandActor(
      {
        type: "group.leave",
        commandId: CommandId.make("command-leave"),
        groupId: GroupId.make("group-1"),
        personId: AuthSessionId.make("person-spoofed"),
      },
      { personId: currentPersonId, displayName: "Current person" },
    );

    expect(command).toMatchObject({ type: "group.leave", personId: currentPersonId });
  });

  it("stamps group creators and turn senders from the authenticated person", () => {
    const actor = { personId: currentPersonId, displayName: "Current person" };
    const group = applyAuthenticatedCommandActor(
      {
        type: "group.create",
        commandId: CommandId.make("command-create"),
        groupId: GroupId.make("group-1"),
        name: "Product",
        bossBotId: BotId.make("bot-1"),
        createdAt: "2026-08-31T00:00:00.000Z",
      },
      actor,
    );
    const turn = applyAuthenticatedCommandActor(
      {
        type: "thread.turn.start",
        commandId: CommandId.make("command-turn"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: MessageId.make("message-1"),
          role: "user",
          text: "Hello",
          attachments: [],
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: "2026-08-31T00:00:00.000Z",
      },
      actor,
    );

    expect(group).toMatchObject({ creator: { personId: currentPersonId } });
    expect(turn).toMatchObject({
      senderPersonId: currentPersonId,
      senderDisplayName: "Current person",
    });
  });

  it("uses the paired session label for group assignment", () => {
    const command = applyKnownGroupPerson(
      {
        type: "group.person.assign",
        commandId: CommandId.make("command-assign"),
        groupId: GroupId.make("group-1"),
        person: {
          kind: "person",
          personId: targetPersonId,
          displayName: "Forged name",
        },
      },
      [targetSession],
    );

    expect(command).toMatchObject({
      person: { personId: targetPersonId, displayName: "Target person" },
    });
  });

  it("rejects an unknown group person", () => {
    expect(
      applyKnownGroupPerson(
        {
          type: "group.person.assign",
          commandId: CommandId.make("command-unknown"),
          groupId: GroupId.make("group-1"),
          person: {
            kind: "person",
            personId: targetPersonId,
            displayName: "Unknown",
          },
        },
        [],
      ),
    ).toBeNull();
  });

  it("rejects unassigning an unknown group person", () => {
    expect(
      applyKnownGroupPerson(
        {
          type: "group.person.unassign",
          commandId: CommandId.make("command-unassign-unknown"),
          groupId: GroupId.make("group-1"),
          personId: targetPersonId,
        },
        [],
      ),
    ).toBeNull();
  });

  it("requires access write to assign or unassign people", () => {
    const assign = {
      type: "group.person.assign" as const,
      commandId: CommandId.make("command-assign-scope"),
      groupId: GroupId.make("group-1"),
      person: {
        kind: "person" as const,
        personId: targetPersonId,
        displayName: "Target person",
      },
    };
    const unassign = {
      type: "group.person.unassign" as const,
      commandId: CommandId.make("command-unassign-scope"),
      groupId: GroupId.make("group-1"),
      personId: targetPersonId,
    };

    expect(canManageGroupPeople(assign, ["orchestration:operate"])).toBe(false);
    expect(canManageGroupPeople(unassign, ["orchestration:operate"])).toBe(false);
    expect(canManageGroupPeople(assign, ["access:write"])).toBe(true);
    expect(canManageGroupPeople(unassign, ["access:write"])).toBe(true);
    expect(canManageGroupPeople(assign, new Set(["access:write"] as const))).toBe(true);
  });

  it("keeps leaving a group available without access write", () => {
    expect(
      canManageGroupPeople(
        {
          type: "group.leave",
          commandId: CommandId.make("command-leave-scope"),
          groupId: GroupId.make("group-1"),
          personId: currentPersonId,
        },
        ["orchestration:operate"],
      ),
    ).toBe(true);
  });
});
