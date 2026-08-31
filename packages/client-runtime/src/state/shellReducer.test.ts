import { describe, expect, it } from "vite-plus/test";

import {
  AkeruDelegationRecord,
  BotId,
  GroupId,
  McpServerId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import type { OrchestrationShellSnapshot, OrchestrationShellStreamEvent } from "@t3tools/contracts";

import { applyShellStreamEvent } from "./shellReducer.ts";

const baseSnapshot: OrchestrationShellSnapshot = {
  snapshotSequence: 0,
  bots: [],
  groups: [],
  delegations: [],
  projects: [],
  threads: [],
  updatedAt: "2026-04-01T00:00:00.000Z",
};

const stubDelegation = Schema.decodeUnknownSync(AkeruDelegationRecord)({
  delegationId: "delegation-1",
  parentDelegationId: null,
  parentBotId: "bot-parent",
  childBotId: "bot-child",
  parentThreadId: "thread-parent",
  childThreadId: null,
  parentTurnId: "turn-parent",
  childTurnId: null,
  ancestorBotIds: ["bot-parent"],
  depth: 1,
  task: "Compare the release options.",
  expectedResult: "A short comparison.",
  deadline: null,
  access: {
    allowedToolIds: ["Read"],
    memoryScopes: ["project"],
    sandbox: "local",
    runtimeMode: "approval-required",
    hasUserComputer: false,
    enabledMcpServerIds: [],
    disabledMcpServerIds: [],
    approvalCeiling: "none",
  },
  state: "queued",
  billedBotId: "bot-child",
  result: null,
  failure: null,
  keep: false,
  createdAt: "2026-04-01T00:00:00.000Z",
  updatedAt: "2026-04-01T00:00:00.000Z",
  startedAt: null,
  completedAt: null,
});

const stubProject = {
  id: ProjectId.make("project-1"),
  title: "Test Project",
  workspaceRoot: "/workspace/test",
  repositoryIdentity: null,
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-04-01T00:00:00.000Z",
  updatedAt: "2026-04-01T00:00:00.000Z",
} as const;

const stubMcpServer = {
  id: McpServerId.make("mcp-server-1"),
  name: "Filesystem",
  transport: "stdio" as const,
  command: "bunx",
  args: ["@modelcontextprotocol/server-filesystem"],
  enabled: true,
  createdAt: "2026-04-01T00:00:00.000Z",
  updatedAt: "2026-04-01T00:00:00.000Z",
};

const stubBot = {
  id: BotId.make("bot-1"),
  name: "Builder",
  title: "Backend engineer",
  label: null,
  description: null,
  disabledMcpServerIds: [],
  avatar: { kind: "dither" as const, seed: "builder" },
  engine: null,
  sandbox: "local" as const,
  runtimeMode: "full-access" as const,
  usageCap: null,
  voiceEnabled: false,
  groupId: null,
  archivedAt: null,
  createdAt: "2026-04-01T00:00:00.000Z",
  updatedAt: "2026-04-01T00:00:00.000Z",
};

const stubGroup = {
  id: GroupId.make("group-1"),
  name: "Engineering",
  bossBotId: stubBot.id,
  members: [{ botId: stubBot.id, role: "boss" as const }],
  createdAt: "2026-04-01T00:00:00.000Z",
  updatedAt: "2026-04-01T00:00:00.000Z",
};

const stubThread = {
  id: ThreadId.make("thread-1"),
  projectId: ProjectId.make("project-1"),
  title: "Test Thread",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
  branch: null,
  worktreePath: null,
  latestTurn: null,
  createdAt: "2026-04-01T00:00:00.000Z",
  updatedAt: "2026-04-01T00:00:00.000Z",
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
  session: null,
} as const;

describe("applyShellStreamEvent", () => {
  it("ignores stale project upserts without mutating the snapshot", () => {
    const snapshotWithProject: OrchestrationShellSnapshot = {
      ...baseSnapshot,
      snapshotSequence: 4,
      bots: [],
      groups: [],
      projects: [stubProject],
    };

    for (const sequence of [3, 4]) {
      const next = applyShellStreamEvent(snapshotWithProject, {
        kind: "project-upserted",
        sequence,
        project: { ...stubProject, title: "Stale Title" },
      });

      expect(next).toBe(snapshotWithProject);
      expect(next.snapshotSequence).toBe(4);
      expect(next.projects[0]?.title).toBe("Test Project");
    }
  });

  describe("project-upserted", () => {
    it("adds a new project", () => {
      const event: OrchestrationShellStreamEvent = {
        kind: "project-upserted",
        sequence: 1,
        project: stubProject,
      };

      const next = applyShellStreamEvent(baseSnapshot, event);

      expect(next.projects).toHaveLength(1);
      expect(next.projects[0]?.id).toBe("project-1");
      expect(next.snapshotSequence).toBe(1);
    });

    it("updates an existing project", () => {
      const snapshotWithProject: OrchestrationShellSnapshot = {
        ...baseSnapshot,
        projects: [stubProject],
      };

      const updatedProject = { ...stubProject, title: "Updated Title" };
      const event: OrchestrationShellStreamEvent = {
        kind: "project-upserted",
        sequence: 2,
        project: updatedProject,
      };

      const next = applyShellStreamEvent(snapshotWithProject, event);

      expect(next.projects).toHaveLength(1);
      expect(next.projects[0]?.title).toBe("Updated Title");
      expect(next.snapshotSequence).toBe(2);
    });
  });

  describe("project-removed", () => {
    it("removes a project by id", () => {
      const snapshotWithProject: OrchestrationShellSnapshot = {
        ...baseSnapshot,
        projects: [stubProject],
      };

      const event: OrchestrationShellStreamEvent = {
        kind: "project-removed",
        sequence: 3,
        projectId: ProjectId.make("project-1"),
      };

      const next = applyShellStreamEvent(snapshotWithProject, event);

      expect(next.projects).toHaveLength(0);
      expect(next.snapshotSequence).toBe(3);
    });
  });

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
        delegation: { ...stubDelegation, state: "running", startedAt: stubDelegation.createdAt },
      });

      expect(updated.delegations).toHaveLength(1);
      expect(updated.delegations[0]?.state).toBe("running");
      expect(updated.snapshotSequence).toBe(10);
    });
  });

  describe("thread-upserted", () => {
    it("adds a new thread", () => {
      const event: OrchestrationShellStreamEvent = {
        kind: "thread-upserted",
        sequence: 4,
        thread: stubThread,
      };

      const next = applyShellStreamEvent(baseSnapshot, event);

      expect(next.threads).toHaveLength(1);
      expect(next.threads[0]?.id).toBe("thread-1");
      expect(next.snapshotSequence).toBe(4);
    });

    it("updates an existing thread", () => {
      const snapshotWithThread: OrchestrationShellSnapshot = {
        ...baseSnapshot,
        threads: [stubThread],
      };

      const updatedThread = { ...stubThread, title: "Updated Thread" };
      const event: OrchestrationShellStreamEvent = {
        kind: "thread-upserted",
        sequence: 5,
        thread: updatedThread,
      };

      const next = applyShellStreamEvent(snapshotWithThread, event);

      expect(next.threads).toHaveLength(1);
      expect(next.threads[0]?.title).toBe("Updated Thread");
    });
  });

  describe("thread-removed", () => {
    it("removes a thread by id", () => {
      const snapshotWithThread: OrchestrationShellSnapshot = {
        ...baseSnapshot,
        threads: [stubThread],
      };

      const event: OrchestrationShellStreamEvent = {
        kind: "thread-removed",
        sequence: 6,
        threadId: ThreadId.make("thread-1"),
      };

      const next = applyShellStreamEvent(snapshotWithThread, event);

      expect(next.threads).toHaveLength(0);
      expect(next.snapshotSequence).toBe(6);
    });
  });

  it("returns original snapshot for unrecognized event kinds", () => {
    const unknownEvent = { kind: "unknown-future-event", sequence: 99 } as any;
    const next = applyShellStreamEvent(baseSnapshot, unknownEvent);
    expect(next).toBe(baseSnapshot);
  });
});
