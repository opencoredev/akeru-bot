import { describe, expect, it } from "vite-plus/test";
import {
  DelegationId,
  SHELL_RECENT_TERMINAL_DELEGATIONS_PER_THREAD,
  ThreadId,
} from "@akeru/contracts";
import { applyShellStreamEvent } from "./shellReducer.ts";
import {
  baseSnapshot,
  stubDelegation,
  completedDelegation,
  stubMcpServer,
} from "./shellReducer.test-support.ts";

describe("applyShellStreamEvent", () => {
  describe("MCP server events", () => {
    it("adds and updates an MCP server", () => {
      const added = applyShellStreamEvent(baseSnapshot, {
        kind: "mcp-server-upserted",
        sequence: 4,
        mcpServer: stubMcpServer,
      });
      const updated = applyShellStreamEvent(added, {
        kind: "mcp-server-upserted",
        sequence: 5,
        mcpServer: { ...stubMcpServer, enabled: false },
      });

      expect(updated.mcpServers).toEqual([{ ...stubMcpServer, enabled: false }]);
      expect(updated.snapshotSequence).toBe(5);
    });

    it("removes an MCP server", () => {
      const next = applyShellStreamEvent(
        { ...baseSnapshot, mcpServers: [stubMcpServer] },
        {
          kind: "mcp-server-removed",
          sequence: 6,
          mcpServerId: stubMcpServer.id,
        },
      );

      expect(next.mcpServers).toEqual([]);
      expect(next.snapshotSequence).toBe(6);
    });
  });

  describe("delegation-upserted", () => {
    it("adds and updates a delegation by id", () => {
      const added = applyShellStreamEvent(baseSnapshot, {
        kind: "delegation-upserted",
        sequence: 9,
        delegation: stubDelegation,
      });
      const updated = applyShellStreamEvent(added, {
        kind: "delegation-upserted",
        sequence: 10,
        delegation: {
          ...stubDelegation,
          phase: {
            _tag: "Running",
            childThreadId: ThreadId.make("thread-child"),
            childTurnId: null,
            startedAt: stubDelegation.createdAt,
            progress: null,
          },
        },
      });

      expect(updated.delegations).toHaveLength(1);
      expect(updated.delegations[0]?.phase._tag).toBe("Running");
      expect(updated.snapshotSequence).toBe(10);
    });

    it("keeps only the newest finished delegations per parent thread", () => {
      const finished = (index: number) =>
        completedDelegation(
          `delegation-finished-${index}`,
          stubDelegation.createdAt,
          `2026-04-02T00:${String(index).padStart(2, "0")}:00.000Z`,
        );
      const open = {
        ...stubDelegation,
        phase: {
          _tag: "Running" as const,
          childThreadId: ThreadId.make("thread-child"),
          childTurnId: null,
          startedAt: stubDelegation.createdAt,
          progress: null,
        },
      };
      const otherThread = {
        ...finished(0),
        delegationId: DelegationId.make("delegation-other-thread"),
        parentThreadId: ThreadId.make("thread-other"),
      };
      let snapshot = applyShellStreamEvent(baseSnapshot, {
        kind: "delegation-upserted",
        sequence: 1,
        delegation: open,
      });
      snapshot = applyShellStreamEvent(snapshot, {
        kind: "delegation-upserted",
        sequence: 2,
        delegation: otherThread,
      });
      const finishedCount = SHELL_RECENT_TERMINAL_DELEGATIONS_PER_THREAD + 5;
      for (let index = 0; index < finishedCount; index++) {
        snapshot = applyShellStreamEvent(snapshot, {
          kind: "delegation-upserted",
          sequence: index + 3,
          delegation: finished(index),
        });
      }

      const ids = snapshot.delegations.map((delegation) => delegation.delegationId);
      expect(ids).toContain(open.delegationId);
      expect(ids).toContain(otherThread.delegationId);
      expect(ids).not.toContain("delegation-finished-4");
      expect(ids).toContain("delegation-finished-5");
      expect(ids).toHaveLength(SHELL_RECENT_TERMINAL_DELEGATIONS_PER_THREAD + 2);
    });

    it("breaks finished delegation ties the same way as the shell snapshot", () => {
      const tied = (index: number) =>
        completedDelegation(
          `delegation-tied-${String(index).padStart(2, "0")}`,
          `2026-04-01T00:${String(index).padStart(2, "0")}:00.000Z`,
          "2026-04-02T00:00:00.000Z",
        );
      let snapshot = baseSnapshot;
      // Arrive newest-created first, so arrival order disagrees with the ranking.
      for (let index = SHELL_RECENT_TERMINAL_DELEGATIONS_PER_THREAD; index >= 0; index--) {
        snapshot = applyShellStreamEvent(snapshot, {
          kind: "delegation-upserted",
          sequence: SHELL_RECENT_TERMINAL_DELEGATIONS_PER_THREAD - index + 1,
          delegation: tied(index),
        });
      }

      const ids = snapshot.delegations.map((delegation) => delegation.delegationId);
      expect(ids).toHaveLength(SHELL_RECENT_TERMINAL_DELEGATIONS_PER_THREAD);
      expect(ids).toContain("delegation-tied-00");
      expect(ids).not.toContain(
        `delegation-tied-${String(SHELL_RECENT_TERMINAL_DELEGATIONS_PER_THREAD).padStart(2, "0")}`,
      );
    });
  });
});
