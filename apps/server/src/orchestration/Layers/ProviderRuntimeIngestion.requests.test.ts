import { ProviderDriverKind } from "@akeru/contracts";
import { ApprovalRequestId, CommandId, RuntimeRequestId, ThreadId } from "@akeru/contracts";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  asThreadId,
  asEventId,
  waitForThread,
  type ProviderRuntimeTestActivity,
  asTurnId,
  createRuntimeIngestionHarness,
} from "./test-support/RuntimeIngestionHarness.ts";

describe("ProviderRuntimeIngestion", () => {
  const testScope = createRuntimeIngestionHarness();
  const { createHarness, userInputEvent } = testScope;
  afterEach(testScope.dispose);
  it("opens and resolves bot inbox approval incidents from runtime requests", async () => {
    const harness = await createHarness({ botOwned: true, threadTitle: "Morning research" });
    const base = {
      provider: ProviderDriverKind.make("codex"),
      threadId: asThreadId("thread-1"),
      createdAt: "2026-01-01T00:00:01.000Z",
      requestId: RuntimeRequestId.make("approval-1"),
    };

    harness.emit({
      ...base,
      type: "request.opened",
      eventId: asEventId("evt-approval-opened"),
      payload: {
        requestType: "command_execution_approval",
        detail: "Allow the booking command?",
      },
    });
    await harness.drain();
    harness.botInbox.reload();
    expect(harness.botInbox.list()).toEqual([
      expect.objectContaining({
        kind: "approval-request",
        status: "open",
        botName: "Akeru",
        taskOrRoutine: "Morning research",
        lastFailure: "Allow the booking command?",
      }),
    ]);

    harness.emit({
      ...base,
      type: "request.resolved",
      eventId: asEventId("evt-approval-resolved"),
      payload: {
        requestType: "command_execution_approval",
        decision: "accept",
      },
    });
    await harness.drain();
    harness.botInbox.reload();
    expect(harness.botInbox.list()[0]?.status).toBe("resolved");
  });

  it("maps canonical request events into approval activities with requestKind", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "request.opened",
      eventId: asEventId("evt-request-opened"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      requestId: ApprovalRequestId.make("req-open"),
      payload: {
        requestType: "command_execution_approval",
        detail: "pwd",
      },
    });

    harness.emit({
      type: "request.resolved",
      eventId: asEventId("evt-request-resolved"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      requestId: ApprovalRequestId.make("req-open"),
      payload: {
        requestType: "command_execution_approval",
        decision: "accept",
      },
    });

    await waitForThread(
      harness,
      (entry) =>
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.kind === "approval.requested",
        ) &&
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.kind === "approval.resolved",
        ),
    );

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread).toBeDefined();

    const requested = thread?.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-request-opened",
    );
    const requestedPayload =
      requested?.payload && typeof requested.payload === "object"
        ? (requested.payload as Record<string, unknown>)
        : undefined;
    expect(requestedPayload?.requestKind).toBe("command");
    expect(requestedPayload?.requestType).toBe("command_execution_approval");

    const resolved = thread?.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-request-resolved",
    );
    const resolvedPayload =
      resolved?.payload && typeof resolved.payload === "object"
        ? (resolved.payload as Record<string, unknown>)
        : undefined;
    expect(resolvedPayload?.requestKind).toBe("command");
    expect(resolvedPayload?.requestType).toBe("command_execution_approval");
  });

  it("removes a pending approval after a lifecycle cancellation", async () => {
    const harness = await createHarness();
    const base = {
      provider: ProviderDriverKind.make("codex"),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-approval-cancel"),
      requestId: RuntimeRequestId.make("request-approval-cancel"),
    };

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-approval-cancel-turn"),
      provider: base.provider,
      threadId: base.threadId,
      turnId: base.turnId,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    await waitForThread(harness, (thread) => thread.session?.activeTurnId === base.turnId);

    harness.emit({
      ...base,
      type: "request.opened",
      eventId: asEventId("evt-approval-cancel-opened"),
      createdAt: "2026-01-01T00:00:00.000Z",
      payload: {
        requestType: "dynamic_tool_call",
        actor: "agent",
        target: "gmail_send_message",
        action: "send",
      },
    });
    const openedThread = await waitForThread(harness, (thread) =>
      thread.activities.some(
        (activity: ProviderRuntimeTestActivity) =>
          activity.id === "evt-approval-cancel-opened" && activity.kind === "approval.requested",
      ),
    );
    expect(
      openedThread.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.id === "evt-approval-cancel-resolved",
      ),
    ).toBe(false);

    harness.emit({
      ...base,
      type: "request.resolved",
      eventId: asEventId("evt-approval-cancel-resolved"),
      createdAt: "2026-01-01T00:00:01.000Z",
      payload: {
        requestType: "dynamic_tool_call",
        decision: "cancel",
        actor: "system",
        target: "gmail_send_message",
        action: "send",
        outcome: "cancelled",
      },
    });

    const thread = await waitForThread(harness, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) =>
          activity.id === "evt-approval-cancel-resolved" && activity.kind === "approval.resolved",
      ),
    );
    const resolved = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-approval-cancel-resolved",
    );
    expect(resolved?.payload).toMatchObject({
      actor: "system",
      target: "gmail_send_message",
      action: "send",
      outcome: "cancelled",
    });
  });

  it("projects structured user input request and resolution as thread activities", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "user-input.requested",
      eventId: asEventId("evt-user-input-requested"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-user-input"),
      requestId: ApprovalRequestId.make("req-user-input-1"),
      payload: {
        questions: [
          {
            id: "sandbox_mode",
            header: "Sandbox",
            question: "Which mode should be used?",
            options: [
              {
                label: "workspace-write",
                description: "Allow workspace writes only",
              },
            ],
          },
        ],
      },
    });

    harness.emit({
      type: "user-input.resolved",
      eventId: asEventId("evt-user-input-resolved"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-user-input"),
      requestId: ApprovalRequestId.make("req-user-input-1"),
      payload: {
        answers: {
          sandbox_mode: "workspace-write",
        },
      },
    });

    const thread = await waitForThread(
      harness,
      (entry) =>
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.kind === "user-input.requested",
        ) &&
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.kind === "user-input.resolved",
        ),
    );

    const requested = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-user-input-requested",
    );
    expect(requested?.kind).toBe("user-input.requested");

    const resolved = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-user-input-resolved",
    );
    const resolvedPayload =
      resolved?.payload && typeof resolved.payload === "object"
        ? (resolved.payload as Record<string, unknown>)
        : undefined;
    expect(resolved?.kind).toBe("user-input.resolved");
    expect(resolvedPayload?.answers).toEqual({
      sandbox_mode: "workspace-write",
    });
  });

  it.each(["completed", "interrupted", "failed"] as const)(
    "resolves native questions when their turn is %s",
    async (state) => {
      const harness = await createHarness();
      const request = userInputEvent("question-turn", "question-request");
      harness.emit({
        type: "turn.started",
        eventId: asEventId("question-started"),
        provider: request.provider,
        threadId: request.threadId,
        turnId: request.turnId,
        createdAt: request.createdAt,
      });
      harness.emit(request);
      await harness.drain();
      expect((await harness.readThreadShell()).hasPendingUserInput).toBe(true);
      harness.emit({
        type: "turn.completed",
        eventId: asEventId("question-completed"),
        provider: request.provider,
        threadId: request.threadId,
        turnId: request.turnId,
        createdAt: "2026-01-01T00:00:03.000Z",
        payload: { state },
      });
      await harness.drain();
      const thread = (await harness.readModel()).threads[0]!;
      expect(thread.session?.activeTurnId).toBeNull();
      expect((await harness.readThreadShell()).hasPendingUserInput).toBe(false);
      expect(
        thread.activities.filter((activity) => activity.kind === "user-input.resolved"),
      ).toMatchObject([{ turnId: request.turnId, payload: { requestId: request.requestId } }]);
    },
  );

  it("resolves native questions when their turn is aborted", async () => {
    const harness = await createHarness();
    const request = userInputEvent("abort-turn", "abort-question");
    harness.emit({
      type: "turn.started",
      eventId: asEventId("abort-started"),
      provider: request.provider,
      threadId: request.threadId,
      turnId: request.turnId,
      createdAt: request.createdAt,
    });
    harness.emit(request);
    await harness.drain();
    harness.emit({
      type: "turn.aborted",
      eventId: asEventId("abort-completed"),
      provider: request.provider,
      threadId: request.threadId,
      turnId: request.turnId,
      createdAt: "2026-01-01T00:00:03.000Z",
      payload: { reason: "Interrupted by user." },
    });
    await harness.drain();
    expect((await harness.readThreadShell()).hasPendingUserInput).toBe(false);
    expect(
      (await harness.readModel()).threads[0]!.activities.filter(
        (activity) => activity.kind === "user-input.resolved",
      ),
    ).toMatchObject([{ payload: { requestId: request.requestId } }]);
  });

  it("resolves a terminal native question after an ordinary response failure", async () => {
    const harness = await createHarness();
    const request = userInputEvent("failed-response-turn", "failed-response-question");
    harness.emit({
      type: "turn.started",
      eventId: asEventId("failed-response-started"),
      provider: request.provider,
      threadId: request.threadId,
      turnId: request.turnId,
      createdAt: request.createdAt,
    });
    harness.emit(request);
    await harness.drain();
    await harness.dispatch({
      type: "thread.activity.append",
      commandId: CommandId.make("cmd-failed-user-input-response"),
      threadId: request.threadId,
      activity: {
        id: asEventId("failed-user-input-response"),
        createdAt: "2026-01-01T00:00:02.000Z",
        tone: "error",
        kind: "provider.user-input.respond.failed",
        summary: "User input response failed",
        payload: {
          requestId: request.requestId,
          detail: "Provider connection failed while sending the response",
        },
        turnId: asTurnId("failed-response-turn"),
      },
      createdAt: "2026-01-01T00:00:02.000Z",
    });

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("failed-response-completed"),
      provider: request.provider,
      threadId: request.threadId,
      turnId: request.turnId,
      createdAt: "2026-01-01T00:00:03.000Z",
      payload: { state: "failed" },
    });
    await harness.drain();

    expect((await harness.readThreadShell()).hasPendingUserInput).toBe(false);
    expect(
      (await harness.readModel()).threads[0]!.activities.filter(
        (activity) => activity.kind === "user-input.resolved",
      ),
    ).toMatchObject([{ payload: { requestId: request.requestId } }]);
  });

  it("preserves answered questions and leaves newer and message-mode questions pending", async () => {
    const harness = await createHarness();
    const answered = userInputEvent("old-turn", "answered-question");
    const unresolved = userInputEvent("old-turn", "old-question");
    const newer = userInputEvent("new-turn", "new-question");
    const asynchronous = userInputEvent("old-turn", "async-question", "message");
    harness.emit(answered);
    harness.emit(unresolved);
    harness.emit(newer);
    harness.emit(asynchronous);
    harness.emit({
      type: "user-input.resolved",
      eventId: asEventId("normal-answer"),
      provider: answered.provider,
      threadId: answered.threadId,
      turnId: answered.turnId,
      requestId: answered.requestId,
      createdAt: "2026-01-01T00:00:02.000Z",
      payload: { answers: { first: "yes", second: "yes" } },
    });
    harness.emit({
      type: "turn.started",
      eventId: asEventId("new-turn-started"),
      provider: newer.provider,
      threadId: newer.threadId,
      turnId: newer.turnId,
      createdAt: "2026-01-01T00:00:03.000Z",
    });
    await harness.drain();
    expect((await harness.readThreadShell()).hasPendingUserInput).toBe(true);
    harness.emit({
      type: "turn.completed",
      eventId: asEventId("old-turn-completed"),
      provider: answered.provider,
      threadId: answered.threadId,
      turnId: answered.turnId,
      createdAt: "2026-01-01T00:00:04.000Z",
      payload: { state: "interrupted" },
    });
    await harness.drain();
    const thread = (await harness.readModel()).threads[0]!;
    expect(thread.session?.activeTurnId).toBe(newer.turnId);
    expect((await harness.readThreadShell()).hasPendingUserInput).toBe(true);
    expect(
      thread.activities.filter((activity) => activity.kind === "user-input.resolved"),
    ).toMatchObject([
      {
        id: "normal-answer",
        payload: { requestId: answered.requestId, answers: { first: "yes", second: "yes" } },
      },
      { turnId: unresolved.turnId, payload: { requestId: unresolved.requestId } },
    ]);
  });
});
