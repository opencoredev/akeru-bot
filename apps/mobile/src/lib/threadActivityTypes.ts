import type { DelegationAction } from "@akeru/client-runtime/delegation-presentation";
import type { PendingApproval } from "@akeru/client-runtime/pending-requests";
import type {
  AkeruDelegationRecord,
  ChannelProvider,
  OrchestrationLatestTurn,
  OrchestrationThread,
  OrchestrationThreadActivity,
  ToolLifecycleItemType,
  TurnId,
} from "@akeru/contracts";
import type { BotStepMeterData } from "../features/threads/botStepUsage";

export interface ThreadFeedActivity {
  readonly id: string;
  readonly createdAt: string;
  readonly turnId: TurnId | null;
  readonly summary: string;
  readonly detail: string | null;
  readonly canExpand: boolean;
  readonly getFullDetail: () => string | null;
  readonly getCopyText: () => string;
  readonly icon:
    | "agent"
    | "alert"
    | "check"
    | "command"
    | "edit"
    | "eye"
    | "globe"
    | "hammer"
    | "message"
    | "warning"
    | "wrench"
    | "zap";
  readonly toolLike: boolean;
  readonly status: "success" | "failure" | "neutral" | null;
}

export type WorkLogToolLifecycleStatus =
  | "inProgress"
  | "completed"
  | "failed"
  | "declined"
  | "stopped";

export interface WorkLogEntry {
  id: string;
  createdAt: string;
  turnId: TurnId | null;
  label: string;
  detail?: string;
  command?: string;
  rawCommand?: string;
  changedFiles?: ReadonlyArray<string>;
  tone: "thinking" | "tool" | "info" | "error";
  toolTitle?: string;
  itemType?: ToolLifecycleItemType;
  requestKind?: PendingApproval["requestKind"];
  toolLifecycleStatus?: WorkLogToolLifecycleStatus;
  toolData?: unknown;
}

export interface DerivedWorkLogEntry extends WorkLogEntry {
  activityKind: OrchestrationThreadActivity["kind"];
  collapseKey?: string;
  /** Grouping key for subagent lifecycle rows (one row per agent). */
  taskId?: string;
}

export type RawThreadFeedEntry =
  | {
      readonly type: "message";
      readonly id: string;
      readonly createdAt: string;
      readonly message: OrchestrationThread["messages"][number];
      /** Provider of the channel conversation this message delivers to, when the
          message is a channel-originated assistant reply. */
      readonly channelProvider?: ChannelProvider;
      readonly botStepMeter?: BotStepMeterData;
    }
  | {
      readonly type: "activity";
      readonly id: string;
      readonly createdAt: string;
      readonly turnId: TurnId | null;
      readonly activity: ThreadFeedActivity;
    };

export type ThreadFeedEntry =
  | Extract<RawThreadFeedEntry, { type: "message" }>
  | {
      readonly type: "delegation";
      readonly id: string;
      readonly createdAt: string;
      readonly delegation: AkeruDelegationRecord;
      /** Reverse-state moves the card offers, judged against the whole chat. */
      readonly actions: ReadonlyArray<DelegationAction>;
    }
  | {
      readonly type: "working";
      readonly id: string;
      readonly createdAt: string;
    }
  | {
      readonly type: "activity-group";
      readonly id: string;
      readonly createdAt: string;
      readonly turnId: TurnId | null;
      readonly activities: ReadonlyArray<ThreadFeedActivity>;
    }
  | {
      readonly type: "work-toggle";
      readonly id: string;
      readonly createdAt: string;
      readonly turnId: TurnId | null;
      readonly groupId: string;
      readonly hiddenCount: number;
      readonly expanded: boolean;
      readonly onlyToolActivities: boolean;
    }
  | {
      readonly type: "turn-fold";
      readonly id: string;
      readonly createdAt: string;
      readonly turnId: TurnId;
      readonly label: string;
      readonly expanded: boolean;
    };

export type ThreadFeedLatestTurn = Pick<
  OrchestrationLatestTurn,
  "turnId" | "state" | "startedAt" | "completedAt"
>;

/**
 * A collapsed row plus the per-activity entries it was merged from. The sources
 * are identity-stable, so they tell whether a row's inputs changed.
 */
export interface CollapsedWorkLogEntry {
  readonly entry: DerivedWorkLogEntry;
  readonly sources: ReadonlyArray<DerivedWorkLogEntry>;
}
