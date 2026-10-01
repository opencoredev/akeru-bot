import { describe, expect, it } from "vite-plus/test";
import { applyShellStreamEvent } from "./shellReducer.ts";
import {
  baseSnapshot,
  stubAssignment,
  stubRoutine,
  stubRoutineRun,
} from "./shellReducer.test-support.ts";

describe("applyShellStreamEvent", () => {
  describe("routine events", () => {
    it("updates routines, run history, and skill assignments", () => {
      const assigned = applyShellStreamEvent(baseSnapshot, {
        kind: "skill-assignment-upserted",
        sequence: 1,
        assignment: stubAssignment,
      });
      const updated = applyShellStreamEvent(assigned, {
        kind: "routine-upserted",
        sequence: 2,
        routine: stubRoutine,
        run: stubRoutineRun,
      });

      expect(updated.skillAssignments).toEqual([stubAssignment]);
      expect(updated.routines).toEqual([stubRoutine]);
      expect(updated.routineRuns).toEqual([stubRoutineRun]);
      expect(updated.snapshotSequence).toBe(2);
    });

    it("keeps a deleted routine's receipt source and run history", () => {
      const receiptSource = {
        id: stubRoutine.id,
        targetThreadId: stubRoutine.targetThreadId,
        job: stubRoutine.job,
        createdAt: stubRoutine.createdAt,
      };
      const next = applyShellStreamEvent(
        { ...baseSnapshot, routines: [stubRoutine], routineRuns: [stubRoutineRun] },
        { kind: "routine-removed", sequence: 3, routineId: stubRoutine.id, receiptSource },
      );

      expect(next.routines).toEqual([]);
      expect(next.routineReceiptSources).toEqual([receiptSource]);
      expect(next.routineRuns).toEqual([stubRoutineRun]);
    });
  });
});
