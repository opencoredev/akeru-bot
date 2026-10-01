import { claudeMessage } from "./test-support/claudeMessages.ts";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { ProviderDriverKind, ProviderInstanceId } from "@akeru/contracts";
import { createModelSelection } from "@akeru/shared/model";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Random from "effect/Random";
import * as Stream from "effect/Stream";
import { ServerConfig } from "../../config.ts";
import { SubscriptionAuthService } from "../../subscription-auth/service.ts";
import {
  ClaudeAdapter,
  makeHarness,
  makeDeterministicRandomService,
  THREAD_ID,
} from "./test-support/claudeAdapterHarness.ts";

describe("ClaudeAdapterLive", () => {
  it.effect("passes a newly saved API key and endpoint to the Claude SDK", () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-claude-api-key-"));
    const harness = makeHarness({ baseDir: directory });

    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const config = yield* ServerConfig;
      const auth = yield* SubscriptionAuthService.forSecretsDir(config.secretsDir);

      const login = yield* Effect.promise(() =>
        auth.startLogin("anthropic", { authMode: "api-key", baseUrl: "https://proxy.example/v1" }),
      );

      yield* Effect.promise(() => auth.completeLogin(login.loginId, "sdk-api-key"));
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      const environment = harness.getLastCreateQueryInput()?.options.env;
      assert.equal(environment?.ANTHROPIC_API_KEY, "sdk-api-key");
      assert.equal(environment?.ANTHROPIC_BASE_URL, "https://proxy.example");
      assert.isUndefined(environment?.CLAUDE_CODE_OAUTH_TOKEN);
      assert.isUndefined(environment?.ANTHROPIC_AUTH_TOKEN);
    }).pipe(
      Effect.provide(harness.layer),
      Effect.ensuring(
        Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
      ),
    );
  });
});

describe("ClaudeAdapterLive", () => {
  it.effect("passes the configured auto-compaction window to Claude", () => {
    const harness = makeHarness({ claudeConfig: { autoCompactWindow: "300000" } });

    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      const options = harness.getLastCreateQueryInput()?.options;
      assert.deepEqual(options?.settings, { autoCompactWindow: 300000 });
      assert.deepEqual(options?.supportedDialogKinds, ["resume_return"]);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });
});

describe("ClaudeAdapterLive", () => {
  it.effect("forwards claude effort levels into query options", () => {
    const harness = makeHarness();

    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-opus-4-6",
          [{ id: "effort", value: "max" }],
        ),
        runtimeMode: "full-access",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.equal(createInput?.options.effort, "max");
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });
});

describe("ClaudeAdapterLive", () => {
  it.effect("runs Claude SDK sessions with the configured CLAUDE_CONFIG_DIR", () => {
    const harness = makeHarness({ claudeConfig: { homePath: "~/.claude-work" } });

    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-opus-4-6",
        ),
        runtimeMode: "full-access",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.equal(
        createInput?.options.env?.CLAUDE_CONFIG_DIR,
        NodePath.join(NodeOS.homedir(), ".claude-work"),
      );
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });
});

describe("ClaudeAdapterLive", () => {
  it.effect("maps the Claude Opus 4.7 default effort to the SDK-supported max value", () => {
    const harness = makeHarness();

    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        modelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-opus-4-7",
        },
        runtimeMode: "full-access",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.equal(createInput?.options.effort, "max");
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });
});

describe("ClaudeAdapterLive", () => {
  it.effect("maps xhigh effort for Claude Opus 4.7 to the SDK-supported max value", () => {
    const harness = makeHarness();

    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-opus-4-7",
          [{ id: "effort", value: "xhigh" }],
        ),
        runtimeMode: "full-access",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.equal(createInput?.options.effort, "max");
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });
});

describe("ClaudeAdapterLive", () => {
  it.effect("preserves xhigh effort for Claude Fable 5", () => {
    const harness = makeHarness();

    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-fable-5",
          [{ id: "effort", value: "xhigh" }],
        ),
        runtimeMode: "full-access",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.equal(createInput?.options.effort, "xhigh");
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });
});

describe("ClaudeAdapterLive", () => {
  it.effect("preserves xhigh effort for Claude Opus 5", () => {
    const harness = makeHarness();

    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-opus-5",
          [{ id: "effort", value: "xhigh" }],
        ),
        runtimeMode: "full-access",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.equal(createInput?.options.effort, "xhigh");
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });
});

describe("ClaudeAdapterLive", () => {
  it.effect("falls back to default effort when unsupported max is requested for Sonnet 4.6", () => {
    const harness = makeHarness();

    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-sonnet-4-6",
          [{ id: "effort", value: "max" }],
        ),
        runtimeMode: "full-access",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.equal(createInput?.options.effort, "high");
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });
});

describe("ClaudeAdapterLive", () => {
  it.effect("ignores adaptive effort for Haiku 4.5", () => {
    const harness = makeHarness();

    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-haiku-4-5",
          [{ id: "effort", value: "high" }],
        ),
        runtimeMode: "full-access",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.equal(createInput?.options.effort, undefined);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });
});

describe("ClaudeAdapterLive", () => {
  it.effect("forwards Claude thinking toggle into SDK settings for Haiku 4.5", () => {
    const harness = makeHarness();

    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-haiku-4-5",
          [{ id: "thinking", value: false }],
        ),
        runtimeMode: "full-access",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.deepEqual(createInput?.options.settings, {
        alwaysThinkingEnabled: false,
      });
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });
});

describe("ClaudeAdapterLive", () => {
  it.effect("ignores Claude thinking toggle for non-Haiku models", () => {
    const harness = makeHarness();

    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-sonnet-4-6",
          [{ id: "thinking", value: false }],
        ),
        runtimeMode: "full-access",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.equal(createInput?.options.settings, undefined);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });
});

describe("ClaudeAdapterLive", () => {
  it.effect("forwards claude fast mode into SDK settings", () => {
    const harness = makeHarness();

    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-opus-4-6",
          [{ id: "fastMode", value: true }],
        ),
        runtimeMode: "full-access",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.deepEqual(createInput?.options.settings, {
        fastMode: true,
      });
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });
});

describe("ClaudeAdapterLive", () => {
  it.effect("ignores claude fast mode for non-opus models", () => {
    const harness = makeHarness();

    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-sonnet-4-6",
          [{ id: "fastMode", value: true }],
        ),
        runtimeMode: "full-access",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.equal(createInput?.options.settings, undefined);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });
});

describe("ClaudeAdapterLive", () => {
  it.effect("does not emit turn.completed for a result with no active turn", () => {
    const harness = makeHarness();

    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      // Collect through session.exited so the window after the second result
      // is deterministically inside the collection: both results are queued
      // after sendTurn returns and drain in order on the one stream consumer.
      const runtimeEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.takeUntil((event) => event.type === "session.exited"),
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      const turn = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      harness.query.emit(
        claudeMessage({
          type: "result",
          subtype: "success",
          is_error: false,
          errors: [],
          num_turns: 1,
          session_id: "sdk-session-1",
          uuid: "result-real",
        }),
      );

      // Second result with no turn in flight — the shape the resume
      // handshake (system/init + result(num_turns: 0)) delivers, and the
      // same completeTurn branch every no-turnState result lands in. This
      // used to emit an untargeted turn.completed; it must emit nothing.
      harness.query.emit(
        claudeMessage({
          type: "result",
          subtype: "success",
          is_error: false,
          errors: [],
          num_turns: 0,
          usage: { input_tokens: 0, output_tokens: 0 },
          session_id: "sdk-session-1",
          uuid: "result-handshake",
        }),
      );

      harness.query.finish();

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const completions = runtimeEvents.filter((event) => event.type === "turn.completed");
      // Exactly one completion — the real turn's, targeted at its turn id.
      // The buggy branch produced a second, untargeted one here.
      assert.equal(completions.length, 1);
      const completed = completions[0];

      if (completed?.type === "turn.completed") {
        assert.equal(String(completed.turnId), String(turn.turnId));
        assert.equal(completed.payload.state, "completed");
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });
});

describe("ClaudeAdapterLive", () => {
  it.effect("steers a running turn instead of opening a new one on mid-turn sendTurn", () => {
    const harness = makeHarness();

    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.takeUntil(
        adapter.streamEvents,
        (event) => event.type === "turn.completed",
      ).pipe(Stream.runCollect, Effect.forkChild);

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      const turn = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "run 5 commands",
        attachments: [],
      });

      // Steer: a second sendTurn while the turn is still running continues
      // the same turn — the message is queued into the live agent loop.
      const steeredTurn = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "actually run 15",
        attachments: [],
      });

      assert.equal(String(steeredTurn.turnId), String(turn.turnId));

      harness.query.emit(
        claudeMessage({
          type: "assistant",
          session_id: "sdk-session-steer",
          uuid: "assistant-steer-1",
          parent_tool_use_id: null,
          message: {
            id: "assistant-message-steer-1",
            content: [{ type: "text", text: "Adjusting to 15." }],
          },
        }),
      );

      harness.query.emit(
        claudeMessage({
          type: "result",
          subtype: "success",
          is_error: false,
          errors: [],
          session_id: "sdk-session-steer",
          uuid: "result-steer-1",
        }),
      );

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const turnStartedEvents = runtimeEvents.filter((event) => event.type === "turn.started");
      const turnCompletedEvents = runtimeEvents.filter((event) => event.type === "turn.completed");

      // One turn boundary for the whole run: the steer produced no
      // turn.completed/turn.started pair.
      assert.equal(turnStartedEvents.length, 1);
      assert.equal(String(turnStartedEvents[0]?.turnId), String(turn.turnId));
      assert.equal(turnCompletedEvents.length, 1);
      assert.equal(String(turnCompletedEvents[0]?.turnId), String(turn.turnId));
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });
});

describe("ClaudeAdapterLive", () => {
  it.effect("falls back to a default plan step label for blank TodoWrite content", () => {
    const harness = makeHarness();

    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 10).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      const turn = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      harness.query.emit(
        claudeMessage({
          type: "stream_event",
          session_id: "sdk-session-todo-plan",
          uuid: "stream-todo-start",
          parent_tool_use_id: null,
          event: {
            type: "content_block_start",
            index: 1,
            content_block: {
              type: "tool_use",
              id: "tool-todo-1",
              name: "TodoWrite",
              input: {},
            },
          },
        }),
      );

      harness.query.emit(
        claudeMessage({
          type: "stream_event",
          session_id: "sdk-session-todo-plan",
          uuid: "stream-todo-input",
          parent_tool_use_id: null,
          event: {
            type: "content_block_delta",
            index: 1,
            delta: {
              type: "input_json_delta",
              partial_json:
                '{"todos":[{"content":"   ","status":"in_progress"},{"content":"Ship it","status":"completed"}]}',
            },
          },
        }),
      );

      harness.query.emit(
        claudeMessage({
          type: "stream_event",
          session_id: "sdk-session-todo-plan",
          uuid: "stream-todo-stop",
          parent_tool_use_id: null,
          event: {
            type: "content_block_stop",
            index: 1,
          },
        }),
      );

      harness.query.emit(
        claudeMessage({
          type: "result",
          subtype: "success",
          is_error: false,
          errors: [],
          session_id: "sdk-session-todo-plan",
          uuid: "result-todo-plan",
        }),
      );

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const planUpdated = runtimeEvents.find((event) => event.type === "turn.plan.updated");
      assert.equal(planUpdated?.type, "turn.plan.updated");

      if (planUpdated?.type === "turn.plan.updated") {
        assert.equal(String(planUpdated.turnId), String(turn.turnId));
        assert.deepEqual(planUpdated.payload.plan, [
          { step: "Task", status: "inProgress" },
          { step: "Ship it", status: "completed" },
        ]);
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });
});
