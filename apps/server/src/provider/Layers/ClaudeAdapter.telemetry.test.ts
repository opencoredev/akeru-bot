// @effect-diagnostics nodeBuiltinImport:off
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { ProviderDriverKind, ProviderRuntimeEvent } from "@akeru/contracts";
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
  it.effect("loads Claude filesystem settings sources for SDK sessions", () => {
    const harness = makeHarness();

    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "approval-required",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.deepEqual(createInput?.options.settingSources, ["user", "project", "local"]);
      assert.equal(createInput?.options.permissionMode, undefined);
      assert.equal(createInput?.options.allowDangerouslySkipPermissions, undefined);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });
});

describe("ClaudeAdapterLive", () => {
  it.effect.each(["success", "error_during_execution"] as const)(
    "preserves %s behavior for an unknown runtime terminal reason",
    (subtype) => {
      const harness = makeHarness();

      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;

        const completionFiber = yield* adapter.streamEvents.pipe(
          Stream.filter((event) => event.type === "turn.completed"),
          Stream.runHead,
          Effect.forkChild,
        );

        const session = yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("claudeAgent"),
          runtimeMode: "full-access",
        });

        yield* adapter.sendTurn({ threadId: session.threadId, input: "hello", attachments: [] });
        harness.query.emit({
          type: "result",
          subtype,
          is_error: subtype !== "success",
          result: "",
          errors: subtype === "success" ? [] : ["Provider error detail"],
          stop_reason: null,
          terminal_reason: "future_terminal_reason",
          session_id: "sdk-session-future-reason",
          uuid: "result-future-reason",
        } as unknown as SDKMessage);
        const completed = yield* Fiber.join(completionFiber);
        assert.equal(completed._tag, "Some");

        if (completed._tag === "Some" && completed.value.type === "turn.completed") {
          assert.equal(
            completed.value.payload.state,
            subtype === "success" ? "completed" : "failed",
          );
          assert.equal(
            completed.value.payload.errorMessage,
            subtype === "success" ? undefined : "Provider error detail",
          );
        }
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );
});

describe("ClaudeAdapterLive", () => {
  it.effect("consumes undeclared and UX-internal system subtypes without warning rows", () => {
    const harness = makeHarness();

    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const runtimeEvents: Array<ProviderRuntimeEvent> = [];

      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => runtimeEvents.push(event)),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      // Undeclared wire-only roster snapshot + every typed UX-internal
      // subtype and top-level type consumed silently: none may surface as
      // unknown-subtype warnings.
      for (const message of [
        {
          type: "system",
          subtype: "background_tasks_changed",
          tasks: [{ task_id: "t1", task_type: "local_agent", description: "Say hi" }],
          session_id: "session",
          uuid: "roster",
        },
        {
          type: "system",
          subtype: "vcs_state_changed",
          kind: "push",
          cwd: "/tmp/worktree",
          session_id: "session",
          uuid: "vcs",
        },
        {
          type: "system",
          subtype: "code_change_published",
          provider: "github",
          url: "https://github.com/pingdotgg/t3code/pull/1",
          repo: "pingdotgg/t3code",
          identifier: "1",
          session_id: "session",
          uuid: "ccp",
        },
        {
          type: "system",
          subtype: "task_updated",
          task_id: "t1",
          patch: { status: "running" },
          session_id: "session",
          uuid: "tu",
        },
        { type: "system", subtype: "commands_changed", session_id: "session", uuid: "cc" },
        { type: "system", subtype: "model_refusal_fallback", session_id: "session", uuid: "mrf" },
        { type: "system", subtype: "local_command_output", session_id: "session", uuid: "lco" },
        { type: "system", subtype: "plugin_install", session_id: "session", uuid: "pi" },
        { type: "system", subtype: "memory_recall", session_id: "session", uuid: "mr" },
        { type: "system", subtype: "elicitation_complete", session_id: "session", uuid: "ec" },
        { type: "prompt_suggestion", suggestion: "try this", session_id: "session", uuid: "ps" },
        {
          type: "system",
          subtype: "notification",
          key: "context",
          text: "low priority note",
          priority: "low",
          session_id: "session",
          uuid: "notif",
        },
      ]) {
        harness.query.emit(message as unknown as SDKMessage);
      }

      // High-priority notifications DO surface as a warning row.
      harness.query.emit({
        type: "system",
        subtype: "notification",
        key: "limit",
        text: "context window nearly full",
        priority: "high",
        session_id: "session",
        uuid: "notif-high",
      } as unknown as SDKMessage);

      // session_state_changed maps to the matching session states.
      for (const [state, uuid] of [
        ["running", "ssc-run"],
        ["requires_action", "ssc-req"],
        ["idle", "ssc-idle"],
      ]) {
        harness.query.emit({
          type: "system",
          subtype: "session_state_changed",
          state,
          session_id: "session",
          uuid,
        } as unknown as SDKMessage);
      }

      // api_retry maps to a session heartbeat, not a warning row.
      harness.query.emit({
        type: "system",
        subtype: "api_retry",
        attempt: 3,
        max_retries: 10,
        retry_delay_ms: 1000,
        error_status: 502,
        error: { type: "api_error" },
        session_id: "session",
        uuid: "retry",
      } as unknown as SDKMessage);
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;

      const warnings = runtimeEvents.filter((event) => event.type === "runtime.warning");
      // Exactly one warning: the high-priority notification. Nothing else.
      assert.deepEqual(
        warnings.map((event) => event.payload.message),
        ["context window nearly full"],
      );

      const sessionStates = runtimeEvents.flatMap((event) => {
        if (event.type !== "session.state.changed") return [];
        const entry = `${event.payload.state}:${event.payload.reason ?? ""}`;

        return entry.includes("session_state") ? [entry] : [];
      });

      assert.deepEqual(sessionStates, [
        "running:session_state:running",
        "waiting:session_state:requires_action",
        "ready:session_state:idle",
      ]);

      const heartbeat = runtimeEvents.find(
        (event) =>
          event.type === "session.state.changed" &&
          typeof event.payload.reason === "string" &&
          event.payload.reason.startsWith("api_retry:"),
      );

      assert.equal(heartbeat?.type, "session.state.changed");
      runtimeEventsFiber.interruptUnsafe();
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });
});
