/**
 * Enforces the bot permission policy for one Claude Code session.
 *
 * The PreToolUse hook runs for every tool call in every permission mode, so
 * `deny` and `ask` hold even when Claude Code would not ask on its own (Full
 * access, Auto, read-only tools). `canUseTool` checks the policy again when
 * Claude Code does ask, and once more after the chat's approval, right before
 * the call runs.
 *
 * @module provider/Layers/claude/ClaudeSessionPolicy
 */
import {
  type HookCallback,
  type HookCallbackMatcher,
  type HookJSONOutput,
  type PermissionResult,
} from "@anthropic-ai/claude-agent-sdk";
import { type ProviderApprovalDecision } from "@akeru/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Ref from "effect/Ref";

import { type ProviderAdapterRequestError } from "../../Errors.ts";
import { readSdkRecord, type SdkRecord } from "../ProtocolJson.ts";
import { type ClaudeSessionContext } from "./ClaudeAdapterState.ts";
import {
  CLAUDE_APPROVAL_TOO_LONG_MESSAGE,
  claudeApprovalTooLong,
  type ClaudeToolApprovalRequest,
} from "./ClaudeApprovalRequests.ts";
import { type ClaudeCodeFileScope } from "../../claudeCode/ClaudeCodeToolPaths.ts";
import { type BotToolPermissionBinding } from "../../tools/BotToolPermissionSessions.ts";
import {
  claudeToolApprovalRejectedMessage,
  claudeToolAskReason,
  claudeToolPolicyDeniedMessage,
  decideClaudeToolCall,
  openClaudeToolApproval,
  recheckClaudeToolApproval,
  type ClaudeToolPolicyDecision,
} from "./ClaudeToolPolicy.ts";

/** Owner approvals wait as long as the approval binding lives. */
const OWNER_APPROVAL_TIMEOUT_SECONDS = 24 * 60 * 60;

const OWNER_APPROVAL_OPTIONS = [
  { decision: "decline", label: "Decline" },
  { decision: "accept", label: "Approve" },
] as const;

type GateResult =
  | { readonly kind: "continue"; readonly decision: ClaudeToolPolicyDecision }
  | { readonly kind: "settled"; readonly result: PermissionResult };

const denied = (message: string) => ({ behavior: "deny", message }) satisfies PermissionResult;

const declinedMessage = (decision: ProviderApprovalDecision) =>
  decision === "cancel" ? "User cancelled tool execution." : "User declined tool execution.";

const isAccepted = (decision: ProviderApprovalDecision) =>
  decision === "accept" || decision === "acceptForSession";

export function createClaudeSessionPolicy(deps: {
  /** Bound when the session started, so a stop that finishes late cannot change it. */
  readonly botPermissions: BotToolPermissionBinding;
  readonly contextRef: Ref.Ref<ClaudeSessionContext | undefined>;
  readonly runPromise: ReturnType<typeof Effect.runPromiseWith<never>>;
  readonly randomUUIDv4: Effect.Effect<string, ProviderAdapterRequestError, never>;
  readonly awaitToolApproval: (
    context: ClaudeSessionContext,
    request: ClaudeToolApprovalRequest,
  ) => Effect.Effect<ProviderApprovalDecision, ProviderAdapterRequestError>;
  /** Where the bot's workspace and Claude Code's own files are. */
  readonly fileScope: ClaudeCodeFileScope;
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
}) {
  const withFiles = <A, E>(
    effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
  ): Effect.Effect<A, E> =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, deps.fileSystem),
      Effect.provideService(Path.Path, deps.path),
    );

  /**
   * Asks the owner about one call and re-checks the policy after a yes. Only
   * Approve and Decline are offered: no permission mode answers for the owner.
   */
  const askOwner = Effect.fn("ClaudeSessionPolicy.askOwner")(function* (
    context: ClaudeSessionContext,
    call: {
      readonly toolName: string;
      readonly toolInput: SdkRecord;
      readonly toolUseID: string | undefined;
      readonly signal: AbortSignal;
    },
    decision: ClaudeToolPolicyDecision,
  ) {
    if (claudeApprovalTooLong(call.toolName, call.toolInput))
      return denied(CLAUDE_APPROVAL_TOO_LONG_MESSAGE);

    const binding = yield* openClaudeToolApproval({
      threadId: context.session.threadId,
      toolUseId: call.toolUseID ?? (yield* deps.randomUUIDv4),
      toolName: call.toolName,
      toolInput: call.toolInput,
      decision,
    });

    const answer = yield* deps.awaitToolApproval(context, {
      ...call,
      reason: `${claudeToolAskReason(decision)} This approval applies only to this action.`,
      options: OWNER_APPROVAL_OPTIONS,
      rawMethod: "botPolicy/owner",
    });

    if (!isAccepted(answer)) return denied(declinedMessage(answer));

    const check = yield* withFiles(
      recheckClaudeToolApproval({
        permissions: deps.botPermissions.current(),
        binding,
        toolName: call.toolName,
        toolInput: call.toolInput,
        fileScope: deps.fileScope,
      }),
    );

    return Predicate.isTagged(check, "Rejected")
      ? denied(claudeToolApprovalRejectedMessage(call.toolName, check.reason))
      : ({ behavior: "allow", updatedInput: call.toolInput } satisfies PermissionResult);
  });

  /** The policy's answer before the chat's permission mode is consulted. */
  const gateToolCall = Effect.fn("ClaudeSessionPolicy.gateToolCall")(function* (
    context: ClaudeSessionContext,
    call: {
      readonly toolName: string;
      readonly toolInput: SdkRecord;
      readonly toolUseID: string | undefined;
      readonly signal: AbortSignal;
    },
  ) {
    const decision = yield* withFiles(
      decideClaudeToolCall(
        deps.botPermissions.current(),
        call.toolName,
        call.toolInput,
        deps.fileScope,
      ),
    );

    switch (decision.verdict.decision) {
      case "allow":
        return { kind: "continue", decision } satisfies GateResult;
      case "deny":
        return {
          kind: "settled",
          result: denied(claudeToolPolicyDeniedMessage(call.toolName, decision)),
        } satisfies GateResult;
      case "ask":
        return {
          kind: "settled",
          result: yield* askOwner(context, call, decision),
        } satisfies GateResult;
      default: {
        const _exhaustive: never = decision.verdict;

        return _exhaustive;
      }
    }
  });

  /**
   * Re-reads the policy after the chat approved a call, right before it runs.
   * The owner answered the chat's prompt, so a policy that now asks is
   * satisfied; one that now denies is not.
   */
  const recheckBeforeRun = Effect.fn("ClaudeSessionPolicy.recheckBeforeRun")(function* (
    context: ClaudeSessionContext,
    toolName: string,
    toolInput: SdkRecord,
  ) {
    return yield* withFiles(
      decideClaudeToolCall(deps.botPermissions.current(), toolName, toolInput, deps.fileScope),
    );
  });

  const preToolUseEffect = Effect.fn("ClaudeSessionPolicy.preToolUse")(function* (
    input: Parameters<HookCallback>[0],
    toolUseID: string | undefined,
    signal: AbortSignal,
  ) {
    if (input.hook_event_name !== "PreToolUse") return { continue: true } satisfies HookJSONOutput;
    const context = yield* Ref.get(deps.contextRef);

    if (!context) return hookDecision("deny", "Claude session context is unavailable.");

    const gate = yield* gateToolCall(context, {
      toolName: input.tool_name,
      toolInput: readSdkRecord(input.tool_input) ?? {},
      toolUseID: toolUseID ?? input.tool_use_id,
      signal,
    });

    if (gate.kind === "continue") return { continue: true } satisfies HookJSONOutput;

    return gate.result.behavior === "allow"
      ? hookDecision("allow", "The owner approved this action.")
      : hookDecision("deny", gate.result.message);
  });

  const preToolUse: HookCallback = (input, toolUseID, options) =>
    deps.runPromise(
      preToolUseEffect(input, toolUseID, options.signal).pipe(
        Effect.catchCause(() =>
          Effect.succeed(hookDecision("deny", "The bot permission policy could not be checked.")),
        ),
      ),
    );

  const hooks: Partial<Record<"PreToolUse", HookCallbackMatcher[]>> = {
    PreToolUse: [{ hooks: [preToolUse], timeout: OWNER_APPROVAL_TIMEOUT_SECONDS }],
  };

  return { hooks, gateToolCall, recheckBeforeRun };
}

function hookDecision(permissionDecision: "allow" | "deny", reason: string): HookJSONOutput {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision,
      permissionDecisionReason: reason,
    },
  };
}
