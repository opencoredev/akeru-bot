import { ApprovalRequestId, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { reactHookHarness as hooks } from "../../test/reactHookHarness";
import { useBotThreadRuntime } from "./useBotThreadRuntime";
import { useRosterPendingApproval } from "./useRosterPendingApproval";

const mocks = vi.hoisted(() => ({
  derivePendingApprovals: vi.fn(),
  useAtomCommand: vi.fn(),
  command: vi.fn(),
  approvalCommand: Symbol("respondToApproval"),
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useCallback: reactHookHarness.useCallback,
    useEffect: () => undefined,
    useMemo: reactHookHarness.useMemo,
    useRef: reactHookHarness.useRef,
    useState: reactHookHarness.useState,
  };
});
vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => [] }));
vi.mock("../../hooks/useSettings", () => ({ usePrimarySettings: () => ({}) }));
vi.mock("../../modelSelection", () => ({ resolveAppModelSelectionState: () => null }));
vi.mock("../../state/entities", () => ({
  useProjects: () => [],
  useThreadShells: () => [],
  useAllEnvironmentShellsBootstrapped: () => true,
  useThreadShell: () => null,
  useThreadMessages: () => [],
  useThreadActivities: () => [],
  readEnvironmentSupportsFileAttachments: () => true,
}));
vi.mock("../../state/bots", () => ({ environmentBotsAtom: () => null }));
vi.mock("../../state/environments", () => ({ usePrimaryEnvironmentId: () => null }));
vi.mock("../../state/server", () => ({ primaryServerProvidersAtom: null }));
vi.mock("../../state/threads", () => ({
  threadEnvironment: { respondToApproval: mocks.approvalCommand },
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: mocks.useAtomCommand }));
vi.mock("../../session-logic", () => ({
  derivePendingApprovals: mocks.derivePendingApprovals,
  derivePendingUserInputs: () => [],
}));
vi.mock("../Sidebar.logic", () => ({ sortScopedProjectsForSidebar: () => [] }));
vi.mock("./rosterStore", () => ({
  useRosterStore: (selector: (state: { bots: []; chatPathByBotId: {} }) => unknown) =>
    selector({ bots: [], chatPathByBotId: {} }),
}));

beforeEach(() => {
  hooks.reset();
  vi.clearAllMocks();
  mocks.derivePendingApprovals.mockReturnValue([]);
  mocks.useAtomCommand.mockReturnValue(mocks.command);
  mocks.command.mockResolvedValue({ _tag: "Success", value: undefined });
});

describe("bot runtime approval ownership", () => {
  it("does not derive approvals or acquire an unused approval command", () => {
    hooks.beginRender();
    const runtime = useBotThreadRuntime("bot-1", null);
    expect(mocks.derivePendingApprovals).not.toHaveBeenCalled();
    expect(
      mocks.useAtomCommand.mock.calls.filter(([command]) => command === mocks.approvalCommand),
    ).toHaveLength(0);
    expect(runtime).not.toHaveProperty("pendingApprovals");
    expect(runtime).not.toHaveProperty("respondToApproval");
    expect(runtime).not.toHaveProperty("respondingToApproval");
  });

  it("derives approvals once and keeps the roster response path active", async () => {
    const requestId = ApprovalRequestId.make("request-1");
    const threadRef = {
      environmentId: EnvironmentId.make("env-a"),
      threadId: ThreadId.make("thread-1"),
    };
    mocks.derivePendingApprovals.mockReturnValue([
      { requestId, requestKind: "command", createdAt: "2026-08-27T00:00:00.000Z" },
    ]);
    hooks.beginRender();
    useBotThreadRuntime("bot-1", null);
    const approval = useRosterPendingApproval(threadRef);
    expect(mocks.derivePendingApprovals).toHaveBeenCalledTimes(1);
    expect(
      mocks.useAtomCommand.mock.calls.filter(([command]) => command === mocks.approvalCommand),
    ).toHaveLength(1);
    expect(approval.pendingApproval?.requestId).toBe(requestId);
    expect(await approval.respond(requestId, "accept")).toBe(true);
    expect(mocks.command).toHaveBeenCalledWith({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, requestId, decision: "accept" },
    });
  });
});
