import { describe, expect, it } from "vite-plus/test";
import type { OrchestrationShellSnapshot } from "@akeru/contracts";
import { applyShellStreamEvent } from "./shellReducer.ts";
import { baseSnapshot, stubBot, stubGroup } from "./shellReducer.test-support.ts";

describe("applyShellStreamEvent", () => {
  describe("bot-upserted", () => {
    it("adds and updates a bot", () => {
      const added = applyShellStreamEvent(baseSnapshot, {
        kind: "bot-upserted",
        sequence: 4,
        bot: stubBot,
      });

      const updated = applyShellStreamEvent(added, {
        kind: "bot-upserted",
        sequence: 5,
        bot: { ...stubBot, name: "Pathfinder" },
      });

      expect(updated.bots).toHaveLength(1);
      expect(updated.bots[0]?.name).toBe("Pathfinder");
      expect(updated.snapshotSequence).toBe(5);
    });
  });

  describe("bot-removed", () => {
    it("removes a bot by id", () => {
      const snapshotWithBot: OrchestrationShellSnapshot = {
        ...baseSnapshot,
        bots: [stubBot],
      };

      const next = applyShellStreamEvent(snapshotWithBot, {
        kind: "bot-removed",
        sequence: 6,
        botId: stubBot.id,
      });

      expect(next.bots).toHaveLength(0);
      expect(next.snapshotSequence).toBe(6);
    });
  });

  describe("group-upserted", () => {
    it("adds and updates a group", () => {
      const added = applyShellStreamEvent(baseSnapshot, {
        kind: "group-upserted",
        sequence: 6,
        group: stubGroup,
      });

      const updated = applyShellStreamEvent(added, {
        kind: "group-upserted",
        sequence: 7,
        group: { ...stubGroup, name: "Discovery", members: [] },
      });

      expect(updated.groups).toHaveLength(1);
      expect(updated.groups[0]?.name).toBe("Discovery");
      expect(updated.groups[0]?.members).toEqual([]);
      expect(updated.snapshotSequence).toBe(7);
    });
  });

  describe("group-removed", () => {
    it("removes a group by id", () => {
      const snapshotWithGroup: OrchestrationShellSnapshot = {
        ...baseSnapshot,
        groups: [stubGroup],
      };

      const next = applyShellStreamEvent(snapshotWithGroup, {
        kind: "group-removed",
        sequence: 8,
        groupId: stubGroup.id,
      });

      expect(next.groups).toHaveLength(0);
      expect(next.snapshotSequence).toBe(8);
    });
  });
});
