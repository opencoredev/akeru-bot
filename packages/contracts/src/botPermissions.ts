import * as Schema from "effect/Schema";

import {
  BotId,
  EnvironmentId,
  IsoDateTime,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { RoutineId } from "./routines.ts";

/**
 * How far an action reaches. `write-outside` covers effects other people or
 * systems see: sending, posting, paying, deleting, publishing, and exposing
 * secrets. `environment-access` covers the user's own computer.
 */
export const BotActionRiskClass = Schema.Literals([
  "read",
  "write-workspace",
  "write-outside",
  "environment-access",
]);

export type BotActionRiskClass = typeof BotActionRiskClass.Type;

export const BOT_ACTION_RISK_CLASSES = BotActionRiskClass.literals;

/** `allow` leaves the action to the chat's permission mode; `ask` needs the owner's answer. */
export const BotPermissionDecision = Schema.Literals(["allow", "ask", "deny"]);

export type BotPermissionDecision = typeof BotPermissionDecision.Type;

export const BotRiskClassDecisions = Schema.Struct({
  read: BotPermissionDecision,
  "write-workspace": BotPermissionDecision,
  "write-outside": BotPermissionDecision,
  "environment-access": BotPermissionDecision,
});

export type BotRiskClassDecisions = typeof BotRiskClassDecisions.Type;

export const BotPermissionPersonId = TrimmedNonEmptyString.pipe(
  Schema.brand("BotPermissionPersonId"),
);

export type BotPermissionPersonId = typeof BotPermissionPersonId.Type;

/** A person the owner lets use this bot, capped per risk class. */
export const BotPermissionPerson = Schema.Struct({
  personId: BotPermissionPersonId,
  riskClasses: BotRiskClassDecisions,
});

export type BotPermissionPerson = typeof BotPermissionPerson.Type;

/**
 * One bot's permission policy. `toolOverrides` is keyed by tool name (built-in
 * tool id, MCP tool name, or Composio tool name) and replaces the risk-class
 * default for that tool.
 */
export const BotPermissionPolicy = Schema.Struct({
  defaults: BotRiskClassDecisions,
  toolOverrides: Schema.Record(TrimmedNonEmptyString, BotPermissionDecision),
  people: Schema.Array(BotPermissionPerson),
});

export type BotPermissionPolicy = typeof BotPermissionPolicy.Type;

/**
 * The policy every bot has until its owner changes it. Outside writes ask;
 * everything else follows the chat's permission mode.
 */
export const DEFAULT_BOT_PERMISSION_POLICY: BotPermissionPolicy = {
  defaults: {
    read: "allow",
    "write-workspace": "allow",
    "write-outside": "ask",
    "environment-access": "allow",
  },
  toolOverrides: {},
  people: [],
};

export const BotOwnerPrincipal = Schema.Struct({ kind: Schema.Literal("owner") });

export const BotPersonPrincipal = Schema.Struct({
  kind: Schema.Literal("person"),
  personId: BotPermissionPersonId,
});

/** A routine run. It acts for the owner. */
export const BotSchedulePrincipal = Schema.Struct({
  kind: Schema.Literal("schedule"),
  routineId: RoutineId,
});

/** A human who can answer an approval. */
export const BotHumanPrincipal = Schema.Union([BotOwnerPrincipal, BotPersonPrincipal]);

export type BotHumanPrincipal = typeof BotHumanPrincipal.Type;

/** Who an action is ultimately for. A bot chain always resolves to one of these. */
export const BotOriginPrincipal = Schema.Union([
  BotOwnerPrincipal,
  BotPersonPrincipal,
  BotSchedulePrincipal,
]);

export type BotOriginPrincipal = typeof BotOriginPrincipal.Type;

/** Another bot asking for work. It carries the origin it acts for. */
export const BotDelegatingPrincipal = Schema.Struct({
  kind: Schema.Literal("bot"),
  botId: BotId,
  onBehalfOf: BotOriginPrincipal,
});

export const BotActionPrincipal = Schema.Union([
  BotOwnerPrincipal,
  BotPersonPrincipal,
  BotSchedulePrincipal,
  BotDelegatingPrincipal,
]);

export type BotActionPrincipal = typeof BotActionPrincipal.Type;

/** Lowercase hex SHA-256 of the canonical JSON form of an action's arguments. */
export const BotActionArgumentsDigest = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{64}$/),
).pipe(Schema.brand("BotActionArgumentsDigest"));

export type BotActionArgumentsDigest = typeof BotActionArgumentsDigest.Type;

export const BotActionFingerprint = Schema.Struct({
  toolId: TrimmedNonEmptyString,
  argumentsDigest: BotActionArgumentsDigest,
});

export type BotActionFingerprint = typeof BotActionFingerprint.Type;

/** The tool call id an approval answers. */
export const BotApprovalId = TrimmedNonEmptyString.pipe(Schema.brand("BotApprovalId"));

export type BotApprovalId = typeof BotApprovalId.Type;

/** An open approval: who asked, who may answer, for which exact action, where, and until when. */
export const BotActionApprovalBinding = Schema.Struct({
  approvalId: BotApprovalId,
  botId: Schema.NullOr(BotId),
  threadId: ThreadId,
  environmentId: EnvironmentId,
  requester: BotActionPrincipal,
  answerer: BotHumanPrincipal,
  action: BotActionFingerprint,
  riskClass: BotActionRiskClass,
  openedAt: IsoDateTime,
  expiresAt: IsoDateTime,
});

export type BotActionApprovalBinding = typeof BotActionApprovalBinding.Type;

export const BotActionApprovalAnswer = Schema.Struct({
  approvalId: BotApprovalId,
  answeredBy: BotHumanPrincipal,
  decision: Schema.Literals(["approve", "decline"]),
  answeredAt: IsoDateTime,
});

export type BotActionApprovalAnswer = typeof BotActionApprovalAnswer.Type;

/**
 * Who authorized an approved run: the owner's explicit answer, or the chat's
 * permission mode answering a routine approval. A mode grant never satisfies
 * an approval the bot policy reserves for the owner.
 */
export const BotApprovalGrantor = Schema.Literals(["owner-answer", "permission-mode"]);

export type BotApprovalGrantor = typeof BotApprovalGrantor.Type;

/** Why an approval answer or an approved execution was refused. */
export const BotApprovalRejection = Schema.Literals([
  "unknown-approval",
  "already-answered",
  "expired",
  "wrong-principal",
  "action-mismatch",
  "environment-mismatch",
  "requester-mismatch",
  "not-approved",
  "owner-approval-required",
  "denied-by-policy",
]);

export type BotApprovalRejection = typeof BotApprovalRejection.Type;
