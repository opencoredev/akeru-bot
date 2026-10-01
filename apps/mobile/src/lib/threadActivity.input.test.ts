import { describe, expect, it } from "vite-plus/test";
import { codexFeedbackMessage } from "@akeru/client-runtime/state/threads";
import { EventId, MessageId } from "@akeru/contracts";
import {
  buildPendingUserInputAnswers,
  derivePendingApprovals,
  deriveThreadFeedPresentation,
  isPendingUserInputOptionSelected,
  setPendingUserInputCustomAnswer,
  togglePendingUserInputOptionSelection,
} from "./threadActivity";
import { makeActivity } from "./threadActivity.test-support";

describe("Codex feedback pseudo-messages", () => {
  it("keeps pending and completed feedback messages in the mobile thread body", () => {
    const pending = {
      id: MessageId.make("feedback-command"),
      command: "/feedback The agent stopped early.",
      createdAt: "2026-08-23T00:00:00.000Z",
      status: "uploading" as const,
    };

    const entries = [codexFeedbackMessage(pending), codexFeedbackMessage(pending, "assistant")].map(
      (message) => ({
        type: "message" as const,
        id: message.id,
        createdAt: message.createdAt,
        message,
      }),
    );

    expect(deriveThreadFeedPresentation(entries, null, new Set())).toEqual(entries);
    expect(entries[1]?.message.text).toBe("Sending feedback to OpenAI...");

    const completed = codexFeedbackMessage(
      { ...pending, status: "sent", feedbackId: "codex-thread-1" },
      "assistant",
    );

    expect(completed.text).toContain("codex-thread-1");
  });
});

const singleSelectQuestion = {
  id: "runtime",
  header: "Runtime",
  question: "Which runtime should be used?",
  options: [
    { label: "Go", description: "One binary" },
    { label: "Node.js", description: "Reuse TypeScript" },
  ],
  multiSelect: false,
} as const;

const multiSelectQuestion = {
  id: "scope",
  header: "Scope",
  question: "Which data should be collected?",
  options: [
    { label: "Orders", description: "Receipts" },
    { label: "Listings", description: "Inventory" },
  ],
  multiSelect: true,
} as const;

describe("pending user input answers", () => {
  it("replaces single-select options and toggles multi-select options", () => {
    expect(
      togglePendingUserInputOptionSelection(
        singleSelectQuestion,
        { selectedOptionLabels: ["Go"] },
        "Node.js",
      ),
    ).toEqual({ customAnswer: "", selectedOptionLabels: ["Node.js"] });

    const orders = togglePendingUserInputOptionSelection(multiSelectQuestion, undefined, "Orders");

    const ordersAndListings = togglePendingUserInputOptionSelection(
      multiSelectQuestion,
      orders,
      "Listings",
    );

    expect(ordersAndListings).toEqual({
      customAnswer: "",
      selectedOptionLabels: ["Orders", "Listings"],
    });
    expect(
      togglePendingUserInputOptionSelection(multiSelectQuestion, ordersAndListings, "Orders"),
    ).toEqual({ customAnswer: "", selectedOptionLabels: ["Listings"] });

    const paddedOrders = togglePendingUserInputOptionSelection(
      multiSelectQuestion,
      undefined,
      "  Orders  ",
    );

    expect(paddedOrders).toEqual({ customAnswer: "", selectedOptionLabels: ["Orders"] });
    expect(
      togglePendingUserInputOptionSelection(multiSelectQuestion, paddedOrders, "  Orders  "),
    ).toEqual({ customAnswer: "" });
  });

  it("builds array answers for multi-select questions", () => {
    expect(
      buildPendingUserInputAnswers([singleSelectQuestion, multiSelectQuestion], {
        runtime: { selectedOptionLabels: ["Go"] },
        scope: { selectedOptionLabels: ["Orders", "Listings"] },
      }),
    ).toEqual({
      runtime: "Go",
      scope: ["Orders", "Listings"],
    });
  });

  it("clears selected options while a custom answer is active", () => {
    expect(
      setPendingUserInputCustomAnswer(
        { selectedOptionLabels: ["Orders", "Listings"] },
        "Orders first",
      ),
    ).toEqual({ customAnswer: "Orders first" });
  });

  it("matches selected chips against normalized option labels", () => {
    expect(
      isPendingUserInputOptionSelected({ selectedOptionLabels: ["Orders"] }, "  Orders  "),
    ).toBe(true);
    expect(
      isPendingUserInputOptionSelected(
        { selectedOptionLabels: ["Orders"], customAnswer: "Orders first" },
        "  Orders  ",
      ),
    ).toBe(false);
  });
});

describe("pending approvals", () => {
  it("keeps app access approvals and persistence choices from remote environments", () => {
    const options = [
      { decision: "decline", label: "Decline" },
      { decision: "acceptAlways", label: "Always allow Safari" },
      { decision: "accept", label: "Approve" },
    ];

    const activity = makeActivity({
      id: EventId.make("approval-safari"),
      kind: "approval.requested",
      summary: "App access approval requested",
      createdAt: "2026-08-24T00:00:00.000Z",
      payload: {
        requestId: "req-safari",
        requestType: "mcp_elicitation_approval",
        detail: "Allow ChatGPT to use Safari?",
        appName: "Safari",
        options,
      },
    });

    expect(derivePendingApprovals([activity])).toEqual([
      {
        requestId: "req-safari",
        requestKind: "mcp-elicitation",
        createdAt: "2026-08-24T00:00:00.000Z",
        detail: "Allow ChatGPT to use Safari?",
        appName: "Safari",
        options,
      },
    ]);
  });

  it("removes an app access approval after a remote client rejects it", () => {
    const requested = makeActivity({
      id: EventId.make("approval-safari-open"),
      kind: "approval.requested",
      summary: "App access approval requested",
      createdAt: "2026-08-24T00:00:00.000Z",
      payload: { requestId: "req-safari", requestKind: "mcp-elicitation" },
    });

    const resolved = makeActivity({
      id: EventId.make("approval-safari-resolved"),
      kind: "approval.resolved",
      summary: "Approval resolved",
      createdAt: "2026-08-24T00:00:01.000Z",
      payload: { requestId: "req-safari", decision: "decline" },
    });

    expect(derivePendingApprovals([requested, resolved])).toEqual([]);
  });

  it("keeps the tool name needed for mobile feedback handling", () => {
    const activity = makeActivity({
      id: EventId.make("approval-feedback"),
      kind: "approval.requested",
      summary: "Approval requested",
      createdAt: "2026-08-30T00:00:00.000Z",
      payload: {
        requestId: "req-feedback",
        requestType: "dynamic_tool_call",
        toolName: "akeru_product_feedback",
      },
    });

    expect(derivePendingApprovals([activity])[0]).toMatchObject({
      toolName: "akeru_product_feedback",
    });
  });
});
