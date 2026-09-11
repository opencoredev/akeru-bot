import { EventId, TurnId, type OrchestrationThreadActivity } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  derivePendingApprovals,
  derivePendingRequests,
  derivePendingUserInputs,
} from "./pendingRequests.ts";

let nextActivityId = 0;

function makeActivity(overrides: {
  id?: string;
  createdAt?: string;
  kind?: string;
  summary?: string;
  tone?: OrchestrationThreadActivity["tone"];
  payload?: Record<string, unknown>;
  turnId?: string;
  sequence?: number;
}): OrchestrationThreadActivity {
  return {
    id: EventId.make(overrides.id ?? `activity-${nextActivityId++}`),
    createdAt: overrides.createdAt ?? "2026-02-23T00:00:00.000Z",
    kind: overrides.kind ?? "tool.started",
    summary: overrides.summary ?? "Tool call",
    tone: overrides.tone ?? "tool",
    payload: overrides.payload ?? {},
    turnId: overrides.turnId ? TurnId.make(overrides.turnId) : null,
    ...(overrides.sequence !== undefined ? { sequence: overrides.sequence } : {}),
  };
}

describe("pending approvals", () => {
  it("carries command arguments from the matching tool activity", () => {
    const args = { command: 'printf "hi\\n"', cwd: null };
    const approvals = derivePendingApprovals([
      makeActivity({
        kind: "tool.started",
        payload: { toolCallId: "shell-1", data: { args } },
      }),
      makeActivity({
        kind: "approval.requested",
        payload: {
          requestId: "shell-1",
          requestKind: "command",
          toolName: "Shell",
        },
      }),
    ]);

    expect(approvals).toEqual([
      {
        requestId: "shell-1",
        requestKind: "command",
        createdAt: "2026-02-23T00:00:00.000Z",
        toolName: "Shell",
        args,
      },
    ]);
  });

  it("maps dynamic_tool_call approvals to the command kind", () => {
    expect(
      derivePendingApprovals([
        makeActivity({
          kind: "approval.requested",
          payload: {
            requestId: "req-dynamic-tool",
            requestType: "dynamic_tool_call",
            detail: "Search the web",
          },
        }),
      ]),
    ).toEqual([
      {
        requestId: "req-dynamic-tool",
        requestKind: "command",
        createdAt: "2026-02-23T00:00:00.000Z",
        detail: "Search the web",
      },
    ]);
  });

  it.each(["tool_user_input", "auth_tokens_refresh"])(
    "does not turn %s into an approval",
    (requestType) => {
      expect(
        derivePendingApprovals([
          makeActivity({
            kind: "approval.requested",
            payload: { requestId: "not-an-approval", requestType },
          }),
        ]),
      ).toEqual([]);
    },
  );

  it("keeps a resolved approval closed when a later request activity arrives", () => {
    const activities = [
      makeActivity({
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "approval.resolved",
        payload: { requestId: "req-closed" },
      }),
      makeActivity({
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "approval.requested",
        payload: { requestId: "req-closed", requestKind: "command" },
      }),
    ];
    expect(derivePendingRequests(activities).approvals).toEqual([]);
  });

  it("clears stale Codex approval callbacks", () => {
    expect(
      derivePendingApprovals([
        makeActivity({
          kind: "approval.requested",
          payload: { requestId: "req-stale-1", requestKind: "command" },
        }),
        makeActivity({
          kind: "provider.approval.respond.failed",
          payload: {
            requestId: "req-stale-1",
            detail: "Unknown pending Codex approval request: req-stale-1",
          },
        }),
      ]),
    ).toEqual([]);
  });
});

describe("pending questions", () => {
  it("keeps free-text questions that do not have options", () => {
    expect(
      derivePendingUserInputs([
        makeActivity({
          kind: "user-input.requested",
          payload: {
            requestId: "req-free-text",
            questions: [
              {
                id: "answer",
                header: "Question",
                question: "What should the bot do next?",
                options: [],
              },
            ],
          },
        }),
      ]),
    ).toMatchObject([
      {
        requestId: "req-free-text",
        questions: [{ id: "answer", question: "What should the bot do next?", options: [] }],
      },
    ]);
  });

  it("keeps a resolved question closed when a later request activity arrives", () => {
    expect(
      derivePendingUserInputs([
        makeActivity({
          createdAt: "2026-02-23T00:00:02.000Z",
          kind: "user-input.resolved",
          payload: { requestId: "req-closed" },
        }),
        makeActivity({
          createdAt: "2026-02-23T00:00:01.000Z",
          kind: "user-input.requested",
          payload: {
            requestId: "req-closed",
            questions: [
              {
                id: "q",
                header: "Q",
                question: "Choose",
                options: [{ label: "yes", description: "Yes" }],
              },
            ],
          },
        }),
      ]),
    ).toEqual([]);
  });

  it("clears stale pending user-input prompts including Codex callback errors", () => {
    expect(
      derivePendingUserInputs([
        makeActivity({
          kind: "user-input.requested",
          payload: {
            requestId: "req-user-input-stale-1",
            questions: [
              {
                id: "sandbox_mode",
                header: "Sandbox",
                question: "Which mode should be used?",
                options: [{ label: "workspace-write", description: "Allow workspace writes only" }],
              },
            ],
          },
        }),
        makeActivity({
          kind: "provider.user-input.respond.failed",
          payload: {
            requestId: "req-user-input-stale-1",
            detail:
              "Provider adapter request failed (codex) for item/tool/requestUserInput: Unknown pending Codex user input request: req-user-input-stale-1",
          },
        }),
      ]),
    ).toEqual([]);
  });

  it("preserves native question ids and option labels without trimming", () => {
    const question = {
      id: "  Which path?\n",
      header: " Path ",
      question: "  Which path?\n",
      options: [{ label: " Keep spaces ", description: "Keep" }],
      multiSelect: false,
    };
    expect(
      derivePendingUserInputs([
        makeActivity({
          kind: "user-input.requested",
          payload: {
            requestId: "native-question",
            questions: [
              question,
              { id: "bad", header: "bad", question: "bad", options: [{ label: 42 }] },
            ],
          },
        }),
      ])[0]?.questions,
    ).toEqual([question]);
  });
});
