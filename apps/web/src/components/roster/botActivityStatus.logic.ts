import {
  derivePendingApprovals,
  derivePendingUserInputs,
} from "@akeru/client-runtime/pending-requests";
import {
  AKERU_CREATE_ROUTINE_TOOL_NAME,
  AKERU_PRODUCT_FEEDBACK_TOOL_NAME,
  type OrchestrationLatestTurn,
  type OrchestrationThreadActivity,
} from "@akeru/contracts";

export interface BotActivity {
  /** Short present-tense update for what the bot is doing, without trailing dots. */
  readonly label: string;
}

// Keyed by the tool name the runtime reports. Names come from the Akeru tool
// catalog, the routine and feedback contracts, and the memory tool.
const TOOL_LABELS: Readonly<Record<string, string>> = {
  [AKERU_CREATE_ROUTINE_TOOL_NAME]: "Adding a routine",
  akeru_list_routines: "Checking routines",
  akeru_delete_routines: "Removing routines",
  [AKERU_PRODUCT_FEEDBACK_TOOL_NAME]: "Drafting feedback",
  Shell: "Running a command",
  ExternalShell: "Running a command",
  AwaitShell: "Waiting on a command",
  AwaitExternalShell: "Waiting on a command",
  Read: "Reading files",
  ExternalRead: "Reading files",
  Screenshot: "Taking a screenshot",
  CopyToBox: "Copying files",
  CopyFromBox: "Copying files",
  request_box_help: "Asking for help",
  CreateAgent: "Starting a helper",
  CheckAgent: "Checking on a helper",
  MessageAgent: "Messaging a helper",
  SendToAgent: "Messaging a helper",
  StopAgent: "Stopping a helper",
  CreateChannel: "Setting up a channel",
  UpdateChannel: "Updating a channel",
  SendToUser: "Sending a message",
  ReactToMessage: "Reacting",
  SearchPlugins: "Searching plugins",
  GetPlugin: "Looking at a plugin",
  InstallPlugin: "Installing a plugin",
  UninstallPlugin: "Removing a plugin",
  GetMcpServerStatus: "Checking connections",
  TestMcpServer: "Testing a connection",
  ReconnectMcpServer: "Reconnecting",
  AuthenticateMcpServer: "Signing in to a connection",
  RestartMcpServers: "Restarting connections",
  UpdateBotProfile: "Updating profile",
  "Computer Use": "Using the computer",
};

const ITEM_TYPE_LABELS: Readonly<Record<string, string>> = {
  command_execution: "Running a command",
  file_change: "Editing files",
  web_search: "Searching the web",
  image_view: "Looking at an image",
  collab_agent_tool_call: "Starting a helper",
  mcp_tool_call: "Using a tool",
  dynamic_tool_call: "Using a tool",
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function payloadRecord(activity: OrchestrationThreadActivity): Record<string, unknown> | null {
  return asRecord(activity.payload) ?? null;
}

function toolCallId(activity: OrchestrationThreadActivity): string {
  const id = payloadRecord(activity)?.toolCallId;
  return typeof id === "string" ? id : activity.id;
}

function toolName(activity: OrchestrationThreadActivity): string {
  // `tool.started` summaries are "<tool name> started"; the name is not stored elsewhere.
  return activity.summary.replace(/ started$/, "");
}

// Task-list tools only update the bot's plan, so they never change the label.
const TASK_LIST_TOOLS = new Set(["task_write", "task_update", "TodoWrite"]);

function memoryLabel(activity: OrchestrationThreadActivity): string {
  const count = asRecord(payloadRecord(activity)?.data)?.memoryOperationCount;
  return typeof count === "number" && count > 0 ? "Saving to memory" : "Reading memory";
}

/** Maps a `tool.started` activity to the label shown while that tool runs. */
export function botToolActivityLabel(activity: OrchestrationThreadActivity): string {
  const name = toolName(activity);
  if (name === "memory") return memoryLabel(activity);
  if (name.startsWith("preview_")) return "Using the browser";
  const known = TOOL_LABELS[name];
  if (known) return known;
  const itemType = payloadRecord(activity)?.itemType;
  return (typeof itemType === "string" ? ITEM_TYPE_LABELS[itemType] : undefined) ?? "Using a tool";
}

/**
 * Describes the running turn from its runtime activities: an open request for
 * the user wins, then the newest unfinished tool call, and otherwise the bot
 * is working between steps.
 */
export function deriveBotActivity(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  latestTurn: OrchestrationLatestTurn | null,
): BotActivity {
  if (latestTurn?.state !== "running") return { label: "Starting" };
  const turnActivities = activities.filter((activity) => activity.turnId === latestTurn.turnId);
  if (derivePendingUserInputs(turnActivities).length > 0) {
    return { label: "Waiting for your answer" };
  }
  if (derivePendingApprovals(turnActivities).length > 0) return { label: "Waiting for approval" };

  const openTools = new Map<string, OrchestrationThreadActivity>();
  for (const activity of turnActivities) {
    if (activity.kind === "tool.started" && !TASK_LIST_TOOLS.has(toolName(activity))) {
      openTools.set(toolCallId(activity), activity);
    } else if (activity.kind === "tool.completed") {
      openTools.delete(toolCallId(activity));
    }
  }
  const openTool = [...openTools.values()].at(-1);
  return { label: openTool ? botToolActivityLabel(openTool) : "Working" };
}
