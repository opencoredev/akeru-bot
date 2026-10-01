// @effect-diagnostics nodeBuiltinImport:off
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { ProviderDriverKind, ProviderInstanceId } from "@akeru/contracts";
import { createModelSelection } from "@akeru/shared/model";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Random from "effect/Random";
import * as Stream from "effect/Stream";
import {
  ClaudeAdapter,
  makeHarness,
  makeDeterministicRandomService,
  THREAD_ID,
} from "./test-support/claudeAdapterHarness.ts";

describe("ClaudeAdapterLive", () => {
  it.effect("classifies Claude Task tool invocations as collaboration agent work", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 8).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "delegate this",
        attachments: [],
      });

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-task",
        uuid: "stream-task-1",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "tool_use",
            id: "tool-task-1",
            name: "Task",
            input: {
              description: "Review the database layer",
              prompt: "Audit the SQL changes",
              subagent_type: "code-reviewer",
            },
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "assistant",
        session_id: "sdk-session-task",
        uuid: "assistant-task-1",
        parent_tool_use_id: null,
        message: {
          id: "assistant-message-task-1",
          content: [{ type: "text", text: "Delegated" }],
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-task",
        uuid: "result-task-1",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const toolStarted = runtimeEvents.find((event) => event.type === "item.started");
      assert.equal(toolStarted?.type, "item.started");
      if (toolStarted?.type === "item.started") {
        assert.equal(toolStarted.payload.itemType, "collab_agent_tool_call");
        assert.equal(toolStarted.payload.title, "Subagent task");
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });
});

describe("ClaudeAdapterLive", () => {
  it.effect("interruptTurn settles live tasks and closes the provider session", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      // Wait for the three task.* runtime events to prove the lifecycle
      // handlers processed the emissions (no wall-clock sleeps under the
      // test clock).
      const taskEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.type.startsWith("task.")),
        Stream.take(3),
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "spawn agents",
        attachments: [],
      });

      harness.query.emit({
        type: "system",
        subtype: "task_started",
        task_id: "task-live",
        description: "Agent A",
        task_type: "local_agent",
        uuid: "task-live-uuid",
        session_id: "sdk-session",
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "system",
        subtype: "task_started",
        task_id: "task-settled",
        description: "Agent B",
        task_type: "local_agent",
        uuid: "task-settled-uuid",
        session_id: "sdk-session",
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "system",
        subtype: "task_notification",
        task_id: "task-settled",
        status: "completed",
        output_file: "/tmp/task-settled.jsonl",
        summary: "done",
        uuid: "task-settled-done-uuid",
        session_id: "sdk-session",
      } as unknown as SDKMessage);

      yield* Fiber.join(taskEventsFiber);

      const stoppedTaskEventFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.type === "task.completed"),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* adapter.interruptTurn(session.threadId);

      // Closing the session is the hard stop because SDK interrupt can leave
      // resumed background work alive.
      assert.equal(harness.query.closeCalls, 1);

      const sessions = yield* adapter.listSessions();
      assert.equal(sessions.length, 0);

      const stoppedTaskEvents = Array.from(yield* Fiber.join(stoppedTaskEventFiber));
      assert.equal(stoppedTaskEvents.length, 1);
      const stoppedTaskEvent = stoppedTaskEvents[0];
      assert.equal(stoppedTaskEvent?.type, "task.completed");
      if (stoppedTaskEvent?.type === "task.completed") {
        assert.equal(String(stoppedTaskEvent.payload.taskId), "task-live");
        assert.equal(stoppedTaskEvent.payload.status, "stopped");
        assert.equal(stoppedTaskEvent.payload.taskType, "local_agent");
        assert.equal(stoppedTaskEvent.payload.title, "Agent A");
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });
});

describe("ClaudeAdapterLive", () => {
  it.effect("workflow member coalescing: identical snapshots suppress, changes emit", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      // Collect task.progress until member-0's tick-3 emission lands, then
      // evaluate member emissions.
      const progressFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.type === "task.progress"),
        Stream.takeUntil(
          // Sentinel: member-0's tick-3 emission (tokens 20) — members are
          // emitted after the coordinator row within a tick.
          (event) =>
            (event.payload as { taskId?: string }).taskId === "wf-coalesce:wf:0" &&
            (event.payload as { typedUsage?: { totalTokens?: number } }).typedUsage?.totalTokens ===
              20,
        ),
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "run workflow",
        attachments: [],
      });

      const memberSnapshot = (tokens: number) => [
        { type: "workflow_phase", index: 0, title: "Work" },
        {
          type: "workflow_agent",
          index: 0,
          state: "running",
          label: "member-0",
          phaseIndex: 0,
          tokens,
        },
        {
          type: "workflow_agent",
          index: 1,
          state: "running",
          label: "member-1",
          phaseIndex: 0,
          tokens: 50,
        },
      ];
      const tick = (usageTotal: number, snapshot: ReturnType<typeof memberSnapshot>) =>
        harness.query.emit({
          type: "system",
          subtype: "task_progress",
          task_id: "wf-coalesce",
          description: "Coalescing workflow",
          usage: { total_tokens: usageTotal, tool_uses: 1, duration_ms: 10 },
          workflow_progress: snapshot,
          uuid: `wf-tick-${usageTotal}`,
          session_id: "sdk-session",
        } as unknown as SDKMessage);

      // Tick 1: both members are new -> 2 member events.
      tick(100, memberSnapshot(10));
      // Tick 2: IDENTICAL member snapshot -> 0 member events (coordinator
      // usage changed, but members did not).
      tick(200, memberSnapshot(10));
      // Tick 3: member-0's tokens advanced -> exactly 1 member event.
      tick(300, memberSnapshot(20));

      const progressEvents = Array.from(yield* Fiber.join(progressFiber));
      const byMember = new Map<string, number>();
      for (const event of progressEvents) {
        const taskId = (event.payload as { taskId: string }).taskId;
        if (!taskId.includes(":wf:")) continue;
        byMember.set(taskId, (byMember.get(taskId) ?? 0) + 1);
      }
      // member-0: tick 1 + tick 3. member-1: tick 1 only (tick 2 identical,
      // tick 3 unchanged).
      assert.equal(byMember.get("wf-coalesce:wf:0"), 2);
      assert.equal(byMember.get("wf-coalesce:wf:1"), 1);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });
});

describe("ClaudeAdapterLive", () => {
  it.effect("task.started carries model/effort; subagent snapshots refine the model", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const taskEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.type.startsWith("task.")),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-opus-4-6",
          [{ id: "effort", value: "max" }],
        ),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "spawn an agent",
        attachments: [],
      });

      // No explicit model/effort on the launch input: the task inherits the
      // session's selection.
      harness.query.emit({
        type: "system",
        subtype: "task_started",
        task_id: "task-model",
        description: "Agent M",
        task_type: "local_agent",
        tool_use_id: "toolu_agent_m",
        uuid: "task-model-uuid",
        session_id: "sdk-session",
      } as unknown as SDKMessage);
      // The subagent's assistant snapshot carries the authoritative API
      // model id, which refines the linkage on later rows.
      harness.query.emit({
        type: "assistant",
        parent_tool_use_id: "toolu_agent_m",
        message: {
          model: "claude-sonnet-5[1m]",
          content: [],
        },
        uuid: "subagent-snapshot-uuid",
        session_id: "sdk-session",
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "system",
        subtype: "task_progress",
        task_id: "task-model",
        description: "Agent M",
        usage: { total_tokens: 100, tool_uses: 1, duration_ms: 10 },
        uuid: "task-model-progress-uuid",
        session_id: "sdk-session",
      } as unknown as SDKMessage);

      const taskEvents = Array.from(yield* Fiber.join(taskEventsFiber));
      const started = taskEvents[0];
      assert.equal(started?.type, "task.started");
      if (started?.type === "task.started") {
        assert.equal(started.payload.model, "claude-opus-4-6");
        assert.equal(started.payload.effort, "max");
      }
      const progress = taskEvents[1];
      assert.equal(progress?.type, "task.progress");
      if (progress?.type === "task.progress") {
        assert.equal(progress.payload.model, "claude-sonnet-5[1m]");
        assert.equal(progress.payload.effort, "max");
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });
});

describe("ClaudeAdapterLive", () => {
  it.effect("a subagent snapshot that beats task_started still wins over the seed", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const taskEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.type.startsWith("task.")),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-opus-4-6",
          [{ id: "effort", value: "max" }],
        ),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "spawn an agent",
        attachments: [],
      });

      // The subagent streams its first assistant snapshot before the task is
      // registered, so there is no agent to refine yet.
      harness.query.emit({
        type: "assistant",
        parent_tool_use_id: "toolu_agent_early",
        message: {
          model: "claude-sonnet-5[1m]",
          content: [],
        },
        uuid: "early-snapshot-uuid",
        session_id: "sdk-session",
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "system",
        subtype: "task_started",
        task_id: "task-early",
        description: "Agent E",
        task_type: "local_agent",
        tool_use_id: "toolu_agent_early",
        uuid: "task-early-uuid",
        session_id: "sdk-session",
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "system",
        subtype: "task_progress",
        task_id: "task-early",
        description: "Agent E",
        usage: { total_tokens: 100, tool_uses: 1, duration_ms: 10 },
        uuid: "task-early-progress-uuid",
        session_id: "sdk-session",
      } as unknown as SDKMessage);

      const taskEvents = Array.from(yield* Fiber.join(taskEventsFiber));
      const started = taskEvents[0];
      assert.equal(started?.type, "task.started");
      if (started?.type === "task.started") {
        assert.equal(started.payload.model, "claude-sonnet-5[1m]");
        assert.equal(started.payload.effort, "max");
      }
      const progress = taskEvents[1];
      assert.equal(progress?.type, "task.progress");
      if (progress?.type === "task.progress") {
        assert.equal(progress.payload.model, "claude-sonnet-5[1m]");
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });
});

describe("ClaudeAdapterLive", () => {
  it.effect("forwards Claude task progress summaries for subagent updates", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 6).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      harness.query.emit({
        type: "system",
        subtype: "task_progress",
        task_id: "task-subagent-1",
        description: "Running background teammate",
        summary: "Code reviewer checked the migration edge cases.",
        usage: {
          total_tokens: 123,
          tool_uses: 4,
          duration_ms: 987,
        },
        session_id: "sdk-session-task-summary",
        uuid: "task-progress-1",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const progressEvent = runtimeEvents.find((event) => event.type === "task.progress");
      assert.equal(progressEvent?.type, "task.progress");
      if (progressEvent?.type === "task.progress") {
        assert.equal(
          progressEvent.payload.summary,
          "Code reviewer checked the migration edge cases.",
        );
        assert.equal(progressEvent.payload.description, "Running background teammate");
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });
});

describe("ClaudeAdapterLive", () => {
  it.effect(
    "preserves oversized Claude result totals after task progress snapshots are recorded",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;

        const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 9).pipe(
          Stream.runCollect,
          Effect.forkChild,
        );

        yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("claudeAgent"),
          runtimeMode: "full-access",
        });

        yield* adapter.sendTurn({
          threadId: THREAD_ID,
          input: "hello",
          attachments: [],
        });

        harness.query.emit({
          type: "system",
          subtype: "task_progress",
          task_id: "task-usage-clamped",
          description: "Thinking through the patch",
          usage: {
            total_tokens: 190000,
          },
          session_id: "sdk-session-task-usage-clamped",
          uuid: "task-usage-progress-clamped",
        } as unknown as SDKMessage);

        harness.query.emit({
          type: "result",
          subtype: "success",
          is_error: false,
          duration_ms: 1234,
          duration_api_ms: 1200,
          num_turns: 1,
          result: "done",
          stop_reason: "end_turn",
          session_id: "sdk-session-result-usage-clamped-after-progress",
          usage: {
            total_tokens: 535000,
          },
          modelUsage: {
            "claude-opus-4-6": {
              contextWindow: 200000,
              maxOutputTokens: 64000,
            },
          },
        } as unknown as SDKMessage);
        harness.query.finish();

        const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
        const usageEvents = runtimeEvents.filter(
          (event) => event.type === "thread.token-usage.updated",
        );
        const finalUsageEvent = usageEvents.at(-1);
        assert.equal(finalUsageEvent?.type, "thread.token-usage.updated");
        if (finalUsageEvent?.type === "thread.token-usage.updated") {
          assert.deepEqual(finalUsageEvent.payload, {
            usage: {
              usedTokens: 190000,
              lastUsedTokens: 190000,
              totalProcessedTokens: 535000,
              maxTokens: 200000,
            },
          });
        }
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );
});
