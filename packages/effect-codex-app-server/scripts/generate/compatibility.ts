import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

export const ManualSchemas = new Map<string, Schema.Json>([
  [
    "GetAuthStatusParams",
    {
      type: "object",
      title: "GetAuthStatusParams",
      properties: {
        includeToken: {
          anyOf: [{ type: "boolean" }, { type: "null" }],
        },
        refreshToken: {
          anyOf: [{ type: "boolean" }, { type: "null" }],
        },
      },
    },
  ],
  [
    "GetConversationSummaryParams",
    {
      title: "GetConversationSummaryParams",
      oneOf: [
        {
          type: "object",
          properties: {
            rolloutPath: { type: "string" },
          },
          required: ["rolloutPath"],
        },
        {
          type: "object",
          properties: {
            conversationId: { type: "string" },
          },
          required: ["conversationId"],
        },
      ],
    },
  ],
  [
    "GetConversationSummaryResponse",
    {
      type: "object",
      title: "GetConversationSummaryResponse",
      properties: {
        summary: {},
      },
      required: ["summary"],
    },
  ],
  [
    "GitDiffToRemoteParams",
    {
      type: "object",
      title: "GitDiffToRemoteParams",
      properties: {
        cwd: { type: "string" },
      },
      required: ["cwd"],
    },
  ],
  [
    "GitDiffToRemoteResponse",
    {
      type: "object",
      title: "GitDiffToRemoteResponse",
      properties: {
        sha: { type: "string" },
        diff: { type: "string" },
      },
      required: ["sha", "diff"],
    },
  ],
  [
    "GetAuthStatusResponse",
    {
      type: "object",
      title: "GetAuthStatusResponse",
      properties: {
        authMethod: {
          anyOf: [{}, { type: "null" }],
        },
        authToken: {
          anyOf: [{ type: "string" }, { type: "null" }],
        },
        requiresOpenaiAuth: {
          anyOf: [{ type: "boolean" }, { type: "null" }],
        },
      },
      required: ["authMethod", "authToken", "requiresOpenaiAuth"],
    },
  ],
]);

// Codex 0.150 added these multi-agent values before our next full protocol
// refresh. Keep every generated response namespace compatible with them.
export const Codex0150DefinitionSchemas = new Map<string, Schema.Json>([
  [
    "CollabAgentTool",
    {
      type: "string",
      enum: [
        "spawnAgent",
        "sendInput",
        "resumeAgent",
        "wait",
        "closeAgent",
        "sendMessage",
        "followupTask",
        "interruptAgent",
        "listAgents",
      ],
    },
  ],
  [
    "CollabAgentToolCallStatus",
    {
      type: "string",
      enum: ["inProgress", "completed", "failed", "interrupted"],
    },
  ],
  [
    "PlanType",
    {
      type: "string",
      enum: [
        "free",
        "go",
        "plus",
        "pro",
        "prolite",
        "team",
        "self_serve_business_prolite",
        "self_serve_business_usage_based",
        "business",
        "ent26",
        "enterprise_cbp_automation",
        "enterprise_cbp_usage_based",
        "enterprise",
        "edu",
        "edu_plus",
        "edu_pro",
        "unknown",
      ],
    },
  ],
  [
    "SubAgentActivityKind",
    {
      type: "string",
      enum: ["started", "interacted", "interrupted", "completed"],
    },
  ],
]);

// Pinned protocol JSON omits later CodexErrorInfo variants. Keep historical
// thread payloads decodable; do not fold unknown values into "other".
const CodexErrorInfoCompatibilityValues = [
  "rateLimitExceeded",
  "misalignmentPolicyViolation",
] as const;

const CodexErrorInfoCompatibilityExports = new Set([
  "V2ThreadReadResponse",
  "V2ThreadResumeResponse",
  "V2ThreadRollbackResponse",
  "V2ThreadForkResponse",
  "V2ThreadListResponse",
  "V2TurnCompletedNotification",
]);

const isEnumUnion = Schema.is(
  Schema.Struct({
    oneOf: Schema.optionalKey(
      Schema.Array(
        Schema.Struct({
          enum: Schema.optionalKey(Schema.Array(Schema.String)),
        }),
      ),
    ),
  }),
);

export function applyCodex0151DefinitionCompatibility(
  exportName: string,
  definitionName: string,
  definitionSchema: Schema.Json,
): Schema.Json {
  if (
    !CodexErrorInfoCompatibilityExports.has(exportName) ||
    definitionName !== "CodexErrorInfo" ||
    Predicate.isString(definitionSchema) ||
    Predicate.isNumber(definitionSchema) ||
    Predicate.isBoolean(definitionSchema)
  ) {
    return definitionSchema;
  }

  if (!isEnumUnion(definitionSchema)) return definitionSchema;
  const schema = definitionSchema;

  const [firstVariant, ...remainingVariants] = schema.oneOf ?? [];
  const currentEnum = firstVariant?.enum;

  if (!currentEnum) {
    return definitionSchema;
  }

  const missingValues = CodexErrorInfoCompatibilityValues.filter(
    (value) => !currentEnum.includes(value),
  );

  if (missingValues.length === 0) {
    return definitionSchema;
  }

  const enumValues = [...currentEnum];
  const otherIndex = enumValues.indexOf("other");

  const nextEnum =
    otherIndex === -1
      ? [...enumValues, ...missingValues]
      : [...enumValues.slice(0, otherIndex), ...missingValues, ...enumValues.slice(otherIndex)];

  return {
    ...definitionSchema,
    oneOf: [{ ...firstVariant, enum: nextEnum }, ...remainingVariants],
  };
}
