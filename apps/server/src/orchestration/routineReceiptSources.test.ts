import type { Routine } from "@akeru/contracts";
import { describe, expect, it } from "vite-plus/test";

import { deletedRoutineReceiptSources } from "./routineReceiptSources.ts";

describe("deleted routine receipt sources", () => {
  it("retains only the chat label of a deleted routine", () => {
    const active = {
      id: "active",
      targetThreadId: "thread-1",
      job: "Active task",
      createdAt: "2026-09-29T00:00:00.000Z",
      deletedAt: null,
      procedure: "Private active instructions",
    } as Routine;
    const deleted = {
      ...active,
      id: "deleted",
      job: "Daily digest",
      deletedAt: "2026-09-29T01:00:00.000Z",
      procedure: "Private deleted instructions",
    } as Routine;

    expect(deletedRoutineReceiptSources([active, deleted])).toEqual([
      {
        id: deleted.id,
        targetThreadId: deleted.targetThreadId,
        job: deleted.job,
        createdAt: deleted.createdAt,
      },
    ]);
  });
});
