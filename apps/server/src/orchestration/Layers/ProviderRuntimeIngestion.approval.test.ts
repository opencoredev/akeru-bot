import {
  EventId,
  ProviderDriverKind,
  RuntimeRequestId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { runtimeEventToActivities } from "./ProviderRuntimeIngestion.ts";

describe("runtimeEventToActivities approval details", () => {
  it("preserves a dynamic tool name and bounded draft arguments", () => {
    const args = { feedback: "Add a shortcut." };
    const event = {
      type: "request.opened",
      eventId: EventId.make("evt-feedback-request"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-08-30T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      requestId: RuntimeRequestId.make("approval-feedback"),
      payload: {
        requestType: "dynamic_tool_call",
        toolName: "akeru_product_feedback",
        args,
      },
    } satisfies ProviderRuntimeEvent;

    const [activity] = runtimeEventToActivities(event);
    expect(activity?.payload).toMatchObject({
      toolName: "akeru_product_feedback",
      args,
    });
  });

  it("drops unrelated and invalid tool arguments before persistence", () => {
    const event = {
      type: "request.opened",
      eventId: EventId.make("evt-unrelated-request"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-08-30T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      requestId: RuntimeRequestId.make("approval-unrelated"),
      payload: {
        requestType: "dynamic_tool_call",
        toolName: "run_private_tool",
        args: { token: "secret" },
      },
    } satisfies ProviderRuntimeEvent;
    const invalidFeedbackEvent = {
      ...event,
      eventId: EventId.make("evt-invalid-feedback-request"),
      requestId: RuntimeRequestId.make("approval-invalid-feedback"),
      payload: {
        ...event.payload,
        toolName: "akeru_product_feedback",
        args: { feedback: "x".repeat(4_001) },
      },
    } satisfies ProviderRuntimeEvent;

    expect(runtimeEventToActivities(event)[0]?.payload).not.toHaveProperty("args");
    expect(runtimeEventToActivities(invalidFeedbackEvent)[0]?.payload).not.toHaveProperty("args");
  });

  it("preserves complete multiline command details", () => {
    const detail = `bun run release -- ${"long-argument ".repeat(20)}\nsecond line`;
    const event = {
      type: "request.opened",
      eventId: EventId.make("evt-request-opened"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-07-18T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      requestId: RuntimeRequestId.make("approval-1"),
      payload: {
        requestType: "command_execution_approval",
        detail,
      },
    } satisfies ProviderRuntimeEvent;

    const [activity] = runtimeEventToActivities(event);

    expect(activity?.kind).toBe("approval.requested");
    expect((activity?.payload as Record<string, unknown> | undefined)?.detail).toBe(detail);
  });

  it("keeps app details and approval options available to remote clients", () => {
    const options = [
      { decision: "decline", label: "Decline" },
      { decision: "acceptAlways", label: "Always allow Safari" },
      { decision: "accept", label: "Approve" },
    ] as const;
    const event = {
      type: "request.opened",
      eventId: EventId.make("evt-mcp-elicitation"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-08-24T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      requestId: RuntimeRequestId.make("approval-safari"),
      payload: {
        requestType: "mcp_elicitation_approval",
        detail: "Allow ChatGPT to use Safari?",
        appName: "Safari",
        options,
      },
    } satisfies ProviderRuntimeEvent;

    const [activity] = runtimeEventToActivities(event);

    expect(activity).toMatchObject({
      kind: "approval.requested",
      summary: "App access approval requested",
      payload: {
        requestId: "approval-safari",
        requestKind: "mcp-elicitation",
        requestType: "mcp_elicitation_approval",
        detail: "Allow ChatGPT to use Safari?",
        appName: "Safari",
        options,
      },
    });
  });
});
