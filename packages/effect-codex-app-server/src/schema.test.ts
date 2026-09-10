import { assert, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import * as CodexSchema from "./schema.ts";

const isGetAccountResponse = Schema.is(CodexSchema.V2GetAccountResponse);
const isThreadReadResponse = Schema.is(CodexSchema.V2ThreadReadResponse);
const isThreadResumeResponse = Schema.is(CodexSchema.V2ThreadResumeResponse);
const isThreadRollbackResponse = Schema.is(CodexSchema.V2ThreadRollbackResponse);
const isThreadForkResponse = Schema.is(CodexSchema.V2ThreadForkResponse);
const isTurnCompletedNotification = Schema.is(CodexSchema.V2TurnCompletedNotification);
const isServerCollabTool = Schema.is(CodexSchema.ServerNotification__CollabAgentTool);
const isResumeCollabTool = Schema.is(CodexSchema.V2ThreadResumeResponse__CollabAgentTool);
const isServerCollabStatus = Schema.is(CodexSchema.ServerNotification__CollabAgentToolCallStatus);
const isResumeCollabStatus = Schema.is(
  CodexSchema.V2ThreadResumeResponse__CollabAgentToolCallStatus,
);
const decodeThreadResumeResponse = Schema.decodeUnknownSync(CodexSchema.V2ThreadResumeResponse);
const isSubAgentActivityKindCompleted = [
  Schema.is(CodexSchema.ServerNotification__SubAgentActivityKind),
  Schema.is(CodexSchema.V2ItemStartedNotification__SubAgentActivityKind),
  Schema.is(CodexSchema.V2ItemCompletedNotification__SubAgentActivityKind),
  Schema.is(CodexSchema.V2ThreadReadResponse__SubAgentActivityKind),
  Schema.is(CodexSchema.V2ThreadResumeResponse__SubAgentActivityKind),
];

it("accepts Codex 0.150 multi-agent values", () => {
  for (const isKind of isSubAgentActivityKindCompleted) {
    assert.equal(isKind("completed"), true);
  }

  for (const tool of ["sendMessage", "followupTask", "interruptAgent", "listAgents"]) {
    assert.equal(isServerCollabTool(tool), true);
    assert.equal(isResumeCollabTool(tool), true);
  }

  assert.equal(isServerCollabStatus("interrupted"), true);
  assert.equal(isResumeCollabStatus("interrupted"), true);

  const resumeResponse = {
    approvalPolicy: "never",
    approvalsReviewer: "user",
    cwd: "/tmp/project",
    model: "gpt-5.6-sol",
    modelProvider: "openai",
    sandbox: { type: "dangerFullAccess" },
    thread: {
      cliVersion: "0.150.0",
      createdAt: 0,
      cwd: "/tmp/project",
      ephemeral: false,
      id: "root-thread",
      modelProvider: "openai",
      preview: "",
      sessionId: "session-1",
      source: "cli",
      status: { type: "idle" },
      turns: [
        {
          id: "turn-1",
          status: "completed",
          items: [
            {
              agentsStates: {},
              id: "item-1",
              receiverThreadIds: ["child-thread"],
              senderThreadId: "root-thread",
              status: "interrupted",
              tool: "followupTask",
              type: "collabAgentToolCall",
            },
          ],
        },
      ],
      updatedAt: 0,
    },
  };

  assert.equal(isThreadResumeResponse(resumeResponse), true);
});

it("accepts Codex 0.150 account plan values", () => {
  const planTypes = [
    "self_serve_business_prolite",
    "ent26",
    "enterprise_cbp_automation",
    "edu_plus",
    "edu_pro",
  ];

  for (const planType of planTypes) {
    const accountResponse = {
      account: {
        email: "user@example.com",
        planType,
        type: "chatgpt",
      },
      requiresOpenaiAuth: true,
    };

    assert.equal(isGetAccountResponse(accountResponse), true);
  }
});

const failedThread = (codexErrorInfo: string, message: string) => ({
  cliVersion: "0.150.0",
  createdAt: 0,
  cwd: "/tmp/project",
  ephemeral: false,
  id: "thread-1",
  modelProvider: "openai",
  preview: "",
  sessionId: "session-1",
  source: "cli",
  status: { type: "idle" },
  turns: [
    {
      error: {
        codexErrorInfo,
        message,
      },
      id: "turn-1",
      items: [],
      status: "failed",
    },
  ],
  updatedAt: 0,
});

const resumeLikeResponse = (thread: ReturnType<typeof failedThread>) => ({
  approvalPolicy: "never",
  approvalsReviewer: "user",
  cwd: "/tmp/project",
  model: "gpt-5.6-sol",
  modelProvider: "openai",
  sandbox: { type: "dangerFullAccess" },
  thread,
});

it("accepts Codex rate limit errors for thread responses", () => {
  const thread = failedThread("rateLimitExceeded", "Rate limit exceeded");
  assert.equal(isThreadReadResponse({ thread }), true);
  assert.equal(isThreadResumeResponse(resumeLikeResponse(thread)), true);
  assert.equal(isThreadRollbackResponse({ thread }), true);
});

it("accepts Codex misalignment policy errors for thread responses", () => {
  const thread = failedThread("misalignmentPolicyViolation", "Misalignment policy violation");
  const resumeResponse = resumeLikeResponse(thread);
  assert.equal(isThreadReadResponse({ thread }), true);
  assert.equal(isThreadResumeResponse(resumeResponse), true);
  assert.equal(isThreadRollbackResponse({ thread }), true);
  assert.equal(isThreadForkResponse(resumeResponse), true);
  const decodedResume = decodeThreadResumeResponse(resumeResponse);
  assert.equal(decodedResume.thread.turns[0]?.error?.codexErrorInfo, "misalignmentPolicyViolation");
  assert.equal(
    isTurnCompletedNotification({
      threadId: "thread-1",
      turn: {
        error: {
          codexErrorInfo: "misalignmentPolicyViolation",
          message: "Misalignment policy violation",
        },
        id: "turn-1",
        items: [],
        status: "failed",
      },
    }),
    true,
  );
});
