import {
  derivePendingApprovals,
  derivePendingUserInputs,
  type PendingApproval,
  type PendingUserInput,
} from "@akeru/client-runtime/pending-requests";
import { ProviderDriverKind } from "@akeru/contracts";

export type ProviderPickerKind = ProviderDriverKind;

export const PROVIDER_OPTIONS: Array<{
  value: ProviderPickerKind;
  label: string;
  available: boolean;
  /** Shown on the model picker sidebar when relevant */
  pickerSidebarBadge?: "new" | "soon";
}> = [
  { value: ProviderDriverKind.make("codex"), label: "Codex", available: true },
  { value: ProviderDriverKind.make("claudeAgent"), label: "Claude", available: true },
  {
    value: ProviderDriverKind.make("opencode"),
    label: "OpenCode",
    available: true,
    pickerSidebarBadge: "new",
  },
  {
    value: ProviderDriverKind.make("grok"),
    label: "Grok",
    available: true,
    pickerSidebarBadge: "new",
  },
  {
    value: ProviderDriverKind.make("kimi"),
    label: "Kimi For Coding",
    available: true,
    pickerSidebarBadge: "new",
  },
  {
    value: ProviderDriverKind.make("opencodeGo"),
    label: "OpenCode Go",
    available: true,
    pickerSidebarBadge: "new",
  },
];

export type { PendingApproval, PendingUserInput };

export { derivePendingApprovals, derivePendingUserInputs };

export { formatDuration, formatElapsed } from "@akeru/shared/orchestrationTiming";

export { deriveWorkLogEntries } from "./session/workLogEntries";

export {
  workLogEntryIsToolLike,
  pluginSearchResultForWorkEntry,
  workEntryDisplayIndicatesToolFailure,
} from "./session/workLogStatus";

export { isLatestTurnSettled, deriveActiveWorkStartedAt } from "./session/turnTiming";

export {
  type WorkLogToolLifecycleStatus,
  type WorkLogEntry,
  type ActivePlanState,
  type TimelineEntry,
  type TurnPlanEntry,
} from "./session/workLogTypes";
