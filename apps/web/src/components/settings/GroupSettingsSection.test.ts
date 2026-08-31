import { BotId, GroupId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { availableSpecialists } from "./GroupSettingsSection";

const bot = (id: string, groupId: string | null, archivedAt: string | null = null) => ({
  id: BotId.make(id),
  name: id,
  groupId: groupId === null ? null : GroupId.make(groupId),
  archivedAt,
});

describe("group settings", () => {
  it("offers every active bot as a specialist", () => {
    expect(
      availableSpecialists([
        bot("free", null),
        bot("assigned", "group-one"),
        bot("archived", null, "2026-08-27T00:00:00.000Z"),
      ]).map((entry) => entry.id),
    ).toEqual(["free", "assigned"]);
  });
});
