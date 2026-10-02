import * as Schema from "effect/Schema";
import { SUBSCRIPTION_PROVIDER_IDS } from "./serviceTypes.ts";

const Provider = Schema.Literals(SUBSCRIPTION_PROVIDER_IDS);

const PollState = Schema.Struct({
  deadlineAt: Schema.Number,
  intervalMs: Schema.Number,
  slowDownResponses: Schema.Number,
});

const DevicePending = Schema.Struct({
  deviceCode: Schema.String,
  userCode: Schema.String,
  url: Schema.String,
  instructions: Schema.String,
  state: PollState,
});

const Login = Schema.Union([
  Schema.Struct({ provider: Schema.Literal("cursor") }),
  Schema.Struct({
    provider: Provider,
    authMode: Schema.Literal("api-key"),
    baseUrl: Schema.optionalKey(Schema.String),
    instanceId: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({
    provider: Schema.Literal("anthropic"),
    verifier: Schema.String,
    instanceId: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({
    provider: Schema.Literal("openai-codex"),
    pending: Schema.Struct({
      deviceAuthId: Schema.String,
      userCode: Schema.String,
      url: Schema.String,
      instructions: Schema.String,
      intervalMs: Schema.Number,
      deadlineAt: Schema.Number,
    }),
    instanceId: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({
    provider: Schema.Literal("xai"),
    pending: DevicePending,
    instanceId: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({
    provider: Schema.Literal("kimi-for-coding"),
    pending: Schema.Struct({ ...DevicePending.fields, deviceId: Schema.String }),
    instanceId: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({
    provider: Schema.Literal("opencode-go"),
    instanceId: Schema.optionalKey(Schema.String),
  }),
]);

const FailureKind = Schema.Literals(["request", "revoked"]);

const HealthCheck = Schema.Struct({
  status: Schema.Literals(["passed", "failed"]),
  checkedAt: Schema.String,
});

const HealthRecord = Schema.Struct({
  lastSuccessfulRequestAt: Schema.optionalKey(Schema.String),
  lastCredentialProbeAt: Schema.optionalKey(Schema.String),
  lastCredentialProbeFailure: Schema.optionalKey(
    Schema.Struct({ at: Schema.String, message: Schema.String, failureKind: FailureKind }),
  ),
  lastFailedRequest: Schema.optionalKey(
    Schema.Struct({
      at: Schema.String,
      message: Schema.String,
      model: Schema.optionalKey(Schema.String),
    }),
  ),
  nextRetryAt: Schema.optionalKey(Schema.String),
  healthTest: Schema.optionalKey(HealthCheck),
  oauthCheck: Schema.optionalKey(HealthCheck),
  failureKind: Schema.optionalKey(FailureKind),
  healthCheckStartedAt: Schema.optionalKey(Schema.String),
  lastGenerationAt: Schema.optionalKey(Schema.String),
});

export const decodePendingLogins = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Array(Schema.Tuple([Schema.String, Login]))),
  { onExcessProperty: "preserve" },
);

export const decodeProviderHealth = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Record(Schema.String, HealthRecord)),
  { onExcessProperty: "preserve" },
);
