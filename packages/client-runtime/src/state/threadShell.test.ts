import {
  BotId,
  EnvironmentId,
  GroupId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationShellSnapshot,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import { Atom, AtomRegistry } from "effect/unstable/reactivity";

import { EMPTY_ENVIRONMENT_CATALOG_STATE } from "./connections.ts";
import { createEnvironmentThreadShellAtoms, latestOwnerThreadIds } from "./threadShell.ts";

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");

function thread(
  id: string,
  updatedAt: string,
  owner: { readonly botId?: string; readonly groupId?: string; readonly archived?: boolean },
): OrchestrationThreadShell {
  return {
    id: ThreadId.make(id),
    projectId: ProjectId.make("project-1"),
    ...(owner.botId ? { botId: BotId.make(owner.botId) } : {}),
    ...(owner.groupId ? { groupId: GroupId.make(owner.groupId) } : {}),
    title: id,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt,
    archivedAt: owner.archived ? updatedAt : null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  } as OrchestrationThreadShell;
}

function snapshot(threads: ReadonlyArray<OrchestrationThreadShell>): OrchestrationShellSnapshot {
  return {
    snapshotSequence: 1,
    updatedAt: "2026-06-01T00:00:00.000Z",
    bots: [],
    groups: [],
    delegations: [],
    projects: [],
    threads: [...threads],
  };
}

describe("latestOwnerThreadIds", () => {
  it("picks the newest unarchived thread per bot and group", () => {
    const latest = latestOwnerThreadIds([
      thread("a-old", "2026-06-01T00:00:00.000Z", { botId: "a" }),
      thread("a-new", "2026-06-02T00:00:00.000Z", { botId: "a" }),
      thread("a-archived", "2026-06-03T00:00:00.000Z", { botId: "a", archived: true }),
      thread("g-1", "2026-06-01T00:00:00.000Z", { groupId: "g" }),
      thread("plain", "2026-06-04T00:00:00.000Z", {}),
    ]);
    expect(latest.byBot.get("a")).toBe("a-new");
    expect(latest.byGroup.get("g")).toBe("g-1");
    expect(latest.byBot.size).toBe(1);
  });
});

describe("latest owner thread atoms", () => {
  function harness(initial: ReadonlyArray<OrchestrationThreadShell>) {
    const snapshotAtom = Atom.make<OrchestrationShellSnapshot | null>(snapshot(initial));
    const atoms = createEnvironmentThreadShellAtoms({
      catalogValueAtom: Atom.make(EMPTY_ENVIRONMENT_CATALOG_STATE),
      snapshotAtom: () => snapshotAtom,
    });
    return { registry: AtomRegistry.make(), snapshotAtom, atoms };
  }

  it("keeps identities and skips notifications when an unrelated thread changes", () => {
    const first = thread("a-1", "2026-06-01T00:00:00.000Z", { botId: "a" });
    const other = thread("b-1", "2026-06-01T00:00:00.000Z", { botId: "b" });
    const { registry, snapshotAtom, atoms } = harness([first, other]);
    const mapAtom = atoms.environmentLatestOwnerThreadIdsAtom(ENVIRONMENT_ID);
    const botAtom = atoms.latestBotThreadIdAtom(ENVIRONMENT_ID, "a");
    const before = registry.get(mapAtom);
    expect(registry.get(botAtom)).toBe("a-1");
    let notifications = 0;
    const unsubscribe = registry.subscribe(botAtom, () => {
      notifications += 1;
    });

    registry.set(
      snapshotAtom,
      snapshot([first, { ...other, updatedAt: "2026-06-05T00:00:00.000Z", title: "Renamed" }]),
    );
    expect(registry.get(mapAtom)).toBe(before);
    expect(registry.get(botAtom)).toBe("a-1");
    expect(notifications).toBe(0);

    registry.set(
      snapshotAtom,
      snapshot([first, other, thread("a-2", "2026-06-06T00:00:00.000Z", { botId: "a" })]),
    );
    expect(registry.get(botAtom)).toBe("a-2");
    expect(notifications).toBe(1);
    unsubscribe();
  });

  it("returns null for a group without threads", () => {
    const { registry, atoms } = harness([]);
    expect(registry.get(atoms.latestGroupThreadIdAtom(ENVIRONMENT_ID, "g"))).toBeNull();
  });
});
