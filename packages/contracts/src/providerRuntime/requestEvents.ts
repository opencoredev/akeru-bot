import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ProviderApprovalOption } from "../orchestration/modelSelection.ts";
import {
  TrimmedNonEmptyStringSchema,
  UnknownRecordSchema,
  CanonicalRequestType,
  RequestOpenedType,
  RequestResolvedType,
  UserInputRequestedType,
  UserInputResolvedType,
  ProviderRuntimeEventBase,
} from "./base.ts";

const RequestOpenedPayload = Schema.Struct({
  requestType: CanonicalRequestType,
  detail: Schema.optional(TrimmedNonEmptyStringSchema),
  actor: Schema.optional(TrimmedNonEmptyStringSchema),
  target: Schema.optional(TrimmedNonEmptyStringSchema),
  appName: Schema.optional(TrimmedNonEmptyStringSchema),
  options: Schema.optional(Schema.Array(ProviderApprovalOption)),
  toolName: Schema.optional(TrimmedNonEmptyStringSchema),
  serverId: Schema.optional(TrimmedNonEmptyStringSchema),
  pluginId: Schema.optional(TrimmedNonEmptyStringSchema),
  action: Schema.optional(TrimmedNonEmptyStringSchema),
  args: Schema.optional(Schema.Unknown),
});

export type RequestOpenedPayload = typeof RequestOpenedPayload.Type;

const RequestResolvedPayload = Schema.Struct({
  requestType: CanonicalRequestType,
  decision: Schema.optional(TrimmedNonEmptyStringSchema),
  actor: Schema.optional(TrimmedNonEmptyStringSchema),
  target: Schema.optional(TrimmedNonEmptyStringSchema),
  action: Schema.optional(TrimmedNonEmptyStringSchema),
  outcome: Schema.optional(TrimmedNonEmptyStringSchema),
  resolution: Schema.optional(Schema.Unknown),
});

export type RequestResolvedPayload = typeof RequestResolvedPayload.Type;

const UserInputQuestionOption = Schema.Struct({
  label: TrimmedNonEmptyStringSchema,
  description: TrimmedNonEmptyStringSchema,
});

export type UserInputQuestionOption = typeof UserInputQuestionOption.Type;

export const UserInputQuestion = Schema.Struct({
  id: TrimmedNonEmptyStringSchema,
  header: TrimmedNonEmptyStringSchema,
  question: TrimmedNonEmptyStringSchema,
  options: Schema.Array(UserInputQuestionOption),
  multiSelect: Schema.optional(Schema.Boolean).pipe(
    Schema.withConstructorDefault(Effect.succeed(false)),
  ),
});

export type UserInputQuestion = typeof UserInputQuestion.Type;

const UserInputRequestedPayload = Schema.Struct({
  questions: Schema.Array(UserInputQuestion),
});

export type UserInputRequestedPayload = typeof UserInputRequestedPayload.Type;

const UserInputResolvedPayload = Schema.Struct({
  answers: UnknownRecordSchema,
});

export type UserInputResolvedPayload = typeof UserInputResolvedPayload.Type;

export const ProviderRuntimeRequestOpenedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: RequestOpenedType,
  payload: RequestOpenedPayload,
});

export type ProviderRuntimeRequestOpenedEvent = typeof ProviderRuntimeRequestOpenedEvent.Type;

export const ProviderRuntimeRequestResolvedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: RequestResolvedType,
  payload: RequestResolvedPayload,
});

export type ProviderRuntimeRequestResolvedEvent = typeof ProviderRuntimeRequestResolvedEvent.Type;

export const ProviderRuntimeUserInputRequestedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: UserInputRequestedType,
  payload: UserInputRequestedPayload,
});

export type ProviderRuntimeUserInputRequestedEvent =
  typeof ProviderRuntimeUserInputRequestedEvent.Type;

export const ProviderRuntimeUserInputResolvedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: UserInputResolvedType,
  payload: UserInputResolvedPayload,
});

export type ProviderRuntimeUserInputResolvedEvent =
  typeof ProviderRuntimeUserInputResolvedEvent.Type;
