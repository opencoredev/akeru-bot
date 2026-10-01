import * as Schema from "effect/Schema";
import * as CodexErrors from "effect-codex-app-server/errors";
import * as CodexRpc from "effect-codex-app-server/rpc";
import * as EffectCodexSchema from "effect-codex-app-server/schema";

export const isCodexAppServerRequestError = Schema.is(CodexErrors.CodexAppServerRequestError);

export function makeThreadOpenResponse(
  threadId: string,
): CodexRpc.ClientRequestResponsesByMethod["thread/start"] {
  return {
    cwd: "/tmp/project",
    model: "gpt-5.3-codex",
    modelProvider: "openai",
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: { type: "danger-full-access" },
    thread: {
      id: threadId,
      createdAt: "2026-04-18T00:00:00.000Z",
      source: { session: "cli" },
      turns: [],
      status: {
        state: "idle",
        activeFlags: [],
      },
    },
  } as unknown as CodexRpc.ClientRequestResponsesByMethod["thread/start"];
}

export const request = {
  mode: "form",
  message: "Allow ChatGPT to use Safari?",
  serverName: "computer-use",
  threadId: "provider-thread-1",
  turnId: "turn-1",
  _meta: {
    app_name: "Safari",
    persist: ["session", "always"],
  },
  requestedSchema: {
    type: "object",
    properties: {
      approval: {
        type: "string",
        oneOf: [
          { const: "once", title: "Allow once" },
          { const: "session", title: "Allow for this session" },
          { const: "always", title: "Always allow Safari" },
        ],
      },
    },
    required: ["approval"],
  },
} satisfies EffectCodexSchema.McpServerElicitationRequestParams;

export function makeThreadStartedNotification(
  threadId: string,
  source: EffectCodexSchema.V2ThreadStartedNotification["thread"]["source"],
  threadSource?: string,
) {
  return {
    method: "thread/started" as const,
    params: {
      thread: {
        cliVersion: "0.0.0",
        createdAt: 0,
        cwd: "/tmp/project",
        ephemeral: true,
        id: threadId,
        modelProvider: "openai",
        preview: "",
        sessionId: threadId,
        source,
        status: { type: "idle" as const },
        ...(threadSource ? { threadSource } : {}),
        turns: [],
        updatedAt: 0,
      },
    },
  };
}
