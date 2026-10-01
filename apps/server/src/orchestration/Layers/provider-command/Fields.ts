import {
  ComposioOperationError,
  type OrchestrationEvent,
  ProviderDriverKind,
  type OrchestrationSession,
  type OrchestrationThreadShell,
  type RuntimeMode,
} from "@akeru/contracts";
import { stripWorktreeBranchPrefix, WORKTREE_BRANCH_PREFIX } from "@akeru/shared/git";
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Schema from "effect/Schema";
import { ProviderAdapterRequestError } from "../../../provider/Errors.ts";
import type { AgentControllerError } from "../../../provider/Errors.ts";
import { BotUsageCapExceeded } from "../../../usage/BotUsageLedger.ts";

export const isProviderAdapterRequestError = Schema.is(ProviderAdapterRequestError);

export const isBotUsageCapExceeded = Schema.is(BotUsageCapExceeded);

export const isComposioOperationError = Schema.is(ComposioOperationError);

export const isProviderDriverKind = Schema.is(ProviderDriverKind);

export type ControllerThreadIdentity = Pick<
  OrchestrationThreadShell,
  "id" | "botId" | "groupId" | "respondingBotId"
>;

export type ControllerEngineThread = ControllerThreadIdentity &
  Pick<OrchestrationThreadShell, "interactionMode">;

export function resolveControllerBotId(
  thread: Pick<OrchestrationThreadShell, "botId" | "respondingBotId">,
) {
  return thread.respondingBotId ?? thread.botId ?? null;
}

export type ProviderIntentEvent = Extract<
  OrchestrationEvent,
  {
    type:
      | "thread.meta-updated"
      | "thread.runtime-mode-set"
      | "thread.turn-start-requested"
      | "thread.turn-resume-requested"
      | "thread.turn-interrupt-requested"
      | "thread.approval-response-requested"
      | "thread.user-input-response-requested"
      | "thread.session-stop-requested"
      | "delegation.updated"
      | "delegation.retry-requested";
  }
>;

export // A failure category describes the failure that set it. Session updates for
// any other reason start from a copy without it so a stale category never
// outlives its failure.
function withoutUnavailability(session: OrchestrationSession): OrchestrationSession {
  const { unavailability: _unavailability, ...rest } = session;

  return rest;
}

export function toNonEmptyProviderInput(value: string | undefined): string | undefined {
  const normalized = value?.trim();

  return normalized && normalized.length > 0 ? normalized : undefined;
}

export function mapProviderSessionStatusToOrchestrationStatus(
  status: "connecting" | "ready" | "running" | "error" | "closed",
): OrchestrationSession["status"] {
  switch (status) {
    case "connecting":
      return "starting";
    case "running":
      return "running";
    case "error":
      return "error";
    case "closed":
      return "stopped";
    case "ready":
    default:
      return "ready";
  }
}

export const turnRequestKeyForEvent = (event: ProviderIntentEvent): string =>
  event.commandId !== null ? `command:${event.commandId}` : `event:${event.eventId}`;

export const HANDLED_TURN_REQUEST_KEY_MAX = 10_000;

export const HANDLED_TURN_REQUEST_KEY_TTL = Duration.minutes(30);

export const DEFAULT_RUNTIME_MODE: RuntimeMode = "full-access";

export const MAX_REGENERATION_ATTACHMENTS = 4;

export const MAX_THREAD_TITLE_CONTEXT_CHARS = 8_000;

export const MAX_FIRST_USER_TITLE_CONTEXT_CHARS = 2_000;

export const STARTUP_RECOVERY_INPUT = [
  "The Akeru server restarted while you were handling the current request.",
  "Continue the existing request from the last durable conversation state.",
  "Inspect the current workspace and tool state before acting, and do not repeat side effects that already completed.",
  "If an approval or question was open, recreate it only if it is still needed.",
].join(" ");

export const MANUAL_RECOVERY_INPUT = [
  "Resume the interrupted request from the last durable conversation state.",
  "Inspect the current workspace and tool state before acting, and do not repeat side effects that already completed.",
  "If an approval or question was open, recreate it only if it is still needed.",
].join(" ");

export const THREAD_TITLE_CONTEXT_TRUNCATION_MARKER = "[Earlier content truncated]\n\n";

export const FIRST_USER_CONTEXT_TRUNCATION_MARKER = "\n[First user message truncated]";

export const PROVIDER_COMMAND_CONCURRENCY = 4;

export function providerErrorLabel(value: string | undefined): string {
  const normalized = value?.trim();

  return normalized && normalized.length > 0 ? normalized : "unknown";
}

export function providerErrorLabelFromInstanceHint(input: {
  readonly instanceId?: string | undefined;
  readonly modelSelectionInstanceId?: string | undefined;
  readonly sessionProvider?: string | undefined;
}): string {
  return providerErrorLabel(
    input.instanceId ?? input.modelSelectionInstanceId ?? input.sessionProvider,
  );
}

export function findProviderAdapterRequestError(
  cause: Cause.Cause<AgentControllerError>,
): ProviderAdapterRequestError | undefined {
  const failReason = cause.reasons.find(Cause.isFailReason);

  return isProviderAdapterRequestError(failReason?.error) ? failReason.error : undefined;
}

export function isUnknownPendingApprovalRequestError(
  cause: Cause.Cause<AgentControllerError>,
): boolean {
  const error = findProviderAdapterRequestError(cause);

  if (error) {
    const detail = error.detail.toLowerCase();

    return (
      detail.includes("unknown pending approval request") ||
      detail.includes("unknown pending permission request") ||
      detail.includes("unknown pending codex approval request")
    );
  }

  const message = Cause.pretty(cause).toLowerCase();

  return (
    message.includes("unknown pending approval request") ||
    message.includes("unknown pending permission request") ||
    message.includes("unknown pending codex approval request")
  );
}

export function isUnknownPendingUserInputRequestError(
  cause: Cause.Cause<AgentControllerError>,
): boolean {
  const error = findProviderAdapterRequestError(cause);

  if (error) {
    const detail = error.detail.toLowerCase();

    return (
      detail.includes("unknown pending user-input request") ||
      detail.includes("unknown pending user input request") ||
      detail.includes("unknown pending codex user input request")
    );
  }

  const message = Cause.pretty(cause).toLowerCase();

  return (
    message.includes("unknown pending user-input request") ||
    message.includes("unknown pending user input request") ||
    message.includes("unknown pending codex user input request")
  );
}

export function isRetryableUserInputResponseError(
  cause: Cause.Cause<AgentControllerError>,
): boolean {
  const error = cause.reasons.find(Cause.isFailReason)?.error;

  return (
    (error?._tag === "AgentControllerRuntimeError" ||
      error?._tag === "ProviderAdapterRequestError") &&
    error.retryable === true
  );
}

export function stalePendingRequestDetail(
  requestKind: "approval" | "user-input",
  requestId: string,
): string {
  return `Stale pending ${requestKind} request: ${requestId}. Provider callback state does not survive app restarts or recovered sessions. Restart the turn to continue.`;
}

export function buildGeneratedWorktreeBranchName(raw: string): string {
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/^refs\/heads\//, "")
    .replace(/['"`]/g, "");

  const withoutPrefix = stripWorktreeBranchPrefix(normalized);

  const branchFragment = withoutPrefix
    .replace(/[^a-z0-9/_-]+/g, "-")
    .replace(/\/+/g, "/")
    .replace(/-+/g, "-")
    .replace(/^[./_-]+|[./_-]+$/g, "")
    .slice(0, 64)
    .replace(/[./_-]+$/g, "");

  const safeFragment = branchFragment.length > 0 ? branchFragment : "update";

  return `${WORKTREE_BRANCH_PREFIX}/${safeFragment}`;
}
