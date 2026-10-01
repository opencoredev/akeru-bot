import type * as Schema from "effect/Schema";
import { claudeMessage } from "./test-support/claudeMessages.ts";
import * as Predicate from "effect/Predicate";
import type { PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import { ApprovalRequestId, ProviderDriverKind, ProviderItemId } from "@akeru/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Random from "effect/Random";
import * as Stream from "effect/Stream";
import {
  ClaudeAdapter,
  makeHarness,
  makeDeterministicRandomService,
  THREAD_ID,
  RESUME_THREAD_ID,
} from "./test-support/claudeAdapterHarness.ts";

describe("ClaudeAdapterLive", () => {
  it.effect("derives bypass permission mode from full-access runtime policy", () => {
    const harness = makeHarness();

    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.deepEqual(createInput?.options.settingSources, ["user", "project", "local"]);
      assert.equal(createInput?.options.permissionMode, "bypassPermissions");
      assert.equal(createInput?.options.allowDangerouslySkipPermissions, true);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });
});

describe("ClaudeAdapterLive", () => {
  it.effect("derives auto permission mode from auto runtime policy without skip flag", () => {
    const harness = makeHarness();

    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "auto",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.equal(createInput?.options.permissionMode, "auto");
      assert.equal(createInput?.options.allowDangerouslySkipPermissions, undefined);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });
});

describe("ClaudeAdapterLive", () => {
  it.effect("bridges approval request/response lifecycle through canUseTool", () => {
    const harness = makeHarness();

    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "approval-required",
      });

      yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runDrain);

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "approve this",
        attachments: [],
      });
      yield* Stream.take(adapter.streamEvents, 1).pipe(Stream.runDrain);

      harness.query.emit(
        claudeMessage({
          type: "stream_event",
          session_id: "sdk-session-approval-1",
          uuid: "stream-approval-thread",
          parent_tool_use_id: null,
          event: {
            type: "message_start",
            message: {
              id: "msg-approval-thread",
            },
          },
        }),
      );

      const threadStarted = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(threadStarted._tag, "Some");

      if (
        !Predicate.isTagged(threadStarted, "Some") ||
        threadStarted.value.type !== "thread.started"
      ) {
        return;
      }

      const createInput = harness.getLastCreateQueryInput();
      const canUseTool = createInput?.options.canUseTool;
      assert.isTrue(Predicate.isFunction(canUseTool));

      if (!canUseTool) {
        return;
      }

      const permissionPromise = canUseTool(
        "Bash",
        { command: "pwd" },
        {
          signal: new AbortController().signal,
          suggestions: [
            {
              type: "setMode",
              mode: "default",
              destination: "session",
            },
          ],
          toolUseID: "tool-use-1",
        },
      );

      const requested = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(requested._tag, "Some");

      if (!Predicate.isTagged(requested, "Some")) {
        return;
      }

      assert.equal(requested.value.type, "request.opened");

      if (requested.value.type !== "request.opened") {
        return;
      }

      assert.deepEqual(requested.value.providerRefs, {
        providerItemId: ProviderItemId.make("tool-use-1"),
      });
      const runtimeRequestId = requested.value.requestId;
      assert.isTrue(Predicate.isString(runtimeRequestId));

      if (runtimeRequestId === undefined) {
        return;
      }

      yield* adapter.respondToRequest(
        session.threadId,
        ApprovalRequestId.make(runtimeRequestId),
        "accept",
      );

      const resolved = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(resolved._tag, "Some");

      if (!Predicate.isTagged(resolved, "Some")) {
        return;
      }

      assert.equal(resolved.value.type, "request.resolved");

      if (resolved.value.type !== "request.resolved") {
        return;
      }

      assert.equal(resolved.value.requestId, requested.value.requestId);
      assert.equal(resolved.value.payload.decision, "accept");
      assert.deepEqual(resolved.value.providerRefs, {
        providerItemId: ProviderItemId.make("tool-use-1"),
      });

      const permissionResult = yield* Effect.promise(() => permissionPromise);
      assert.equal((permissionResult as PermissionResult).behavior, "allow");
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });
});

describe("ClaudeAdapterLive", () => {
  it.effect("acceptForSession returns session-scoped permission updates", () => {
    const harness = makeHarness();

    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "approval-required",
      });

      yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runDrain);

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "approve this for the session",
        attachments: [],
      });
      yield* Stream.take(adapter.streamEvents, 1).pipe(Stream.runDrain);

      const createInput = harness.getLastCreateQueryInput();
      const canUseTool = createInput?.options.canUseTool;
      assert.isTrue(Predicate.isFunction(canUseTool));

      if (!canUseTool) {
        return;
      }

      const respondToNextRequest = Effect.gen(function* () {
        const requested = yield* Stream.runHead(adapter.streamEvents);
        assert.equal(requested._tag, "Some");

        if (!Predicate.isTagged(requested, "Some") || requested.value.type !== "request.opened") {
          return;
        }

        const runtimeRequestId = requested.value.requestId;
        assert.isTrue(Predicate.isString(runtimeRequestId));

        if (runtimeRequestId === undefined) {
          return;
        }

        yield* adapter.respondToRequest(
          session.threadId,
          ApprovalRequestId.make(runtimeRequestId),
          "acceptForSession",
        );
        yield* Stream.take(adapter.streamEvents, 1).pipe(Stream.runDrain);
      });

      // MCP tools frequently arrive with no usable suggestion (Claude Code
      // sends an empty array); the decision must still stick for the session.
      const mcpPermissionPromise = canUseTool(
        "mcp__linear__create_issue",
        { title: "hello" },
        {
          signal: new AbortController().signal,
          suggestions: [],
          toolUseID: "tool-use-mcp-1",
        },
      );

      yield* respondToNextRequest;
      const mcpPermission = (yield* Effect.promise(() => mcpPermissionPromise)) as PermissionResult;
      assert.equal(mcpPermission.behavior, "allow");

      if (mcpPermission.behavior !== "allow") {
        return;
      }

      assert.deepEqual(mcpPermission.updatedPermissions, [
        {
          type: "addRules",
          rules: [{ toolName: "mcp__linear__create_issue" }],
          behavior: "allow",
          destination: "session",
        },
      ]);

      // Received suggestions are reused but rescoped to the session —
      // echoing "localSettings" would persist a session-only choice to disk.
      const bashPermissionPromise = canUseTool(
        "Bash",
        { command: "git status" },
        {
          signal: new AbortController().signal,
          suggestions: [
            {
              type: "addRules",
              rules: [{ toolName: "Bash", ruleContent: "git status" }],
              behavior: "allow",
              destination: "localSettings",
            },
          ],
          toolUseID: "tool-use-bash-1",
        },
      );

      yield* respondToNextRequest;

      const bashPermission = (yield* Effect.promise(
        () => bashPermissionPromise,
      )) as PermissionResult;

      assert.equal(bashPermission.behavior, "allow");

      if (bashPermission.behavior !== "allow") {
        return;
      }

      assert.deepEqual(bashPermission.updatedPermissions, [
        {
          type: "addRules",
          rules: [{ toolName: "Bash", ruleContent: "git status" }],
          behavior: "allow",
          destination: "session",
        },
      ]);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });
});

describe("ClaudeAdapterLive", () => {
  it.effect("classifies Agent tools and read-only Claude tools correctly for approvals", () => {
    const harness = makeHarness();

    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "approval-required",
      });

      yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runDrain);

      const createInput = harness.getLastCreateQueryInput();
      const canUseTool = createInput?.options.canUseTool;
      assert.isTrue(Predicate.isFunction(canUseTool));

      if (!canUseTool) {
        return;
      }

      const agentPermissionPromise = canUseTool(
        "Agent",
        {},
        {
          signal: new AbortController().signal,
          toolUseID: "tool-agent-1",
        },
      );

      const agentRequested = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(agentRequested._tag, "Some");

      if (
        !Predicate.isTagged(agentRequested, "Some") ||
        agentRequested.value.type !== "request.opened"
      ) {
        return;
      }

      assert.equal(agentRequested.value.payload.requestType, "dynamic_tool_call");

      yield* adapter.respondToRequest(
        session.threadId,
        ApprovalRequestId.make(String(agentRequested.value.requestId)),
        "accept",
      );
      yield* Stream.runHead(adapter.streamEvents);
      yield* Effect.promise(() => agentPermissionPromise);

      const grepPermissionPromise = canUseTool(
        "Grep",
        { pattern: "foo", path: "src" },
        {
          signal: new AbortController().signal,
          toolUseID: "tool-grep-approval-1",
        },
      );

      const grepRequested = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(grepRequested._tag, "Some");

      if (
        !Predicate.isTagged(grepRequested, "Some") ||
        grepRequested.value.type !== "request.opened"
      ) {
        return;
      }

      assert.equal(grepRequested.value.payload.requestType, "file_read_approval");

      yield* adapter.respondToRequest(
        session.threadId,
        ApprovalRequestId.make(String(grepRequested.value.requestId)),
        "accept",
      );
      yield* Stream.runHead(adapter.streamEvents);
      yield* Effect.promise(() => grepPermissionPromise);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });
});

describe("ClaudeAdapterLive", () => {
  it.effect("never enters the plan permission mode, even for a stored plan-mode turn", () => {
    const harness = makeHarness();

    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "plan this for me",
        interactionMode: "plan",
        attachments: [],
      });

      assert.deepEqual(harness.query.setPermissionModeCalls, ["bypassPermissions"]);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });
});

describe("ClaudeAdapterLive", () => {
  it.effect("does not call setPermissionMode when interactionMode is absent", () => {
    const harness = makeHarness();

    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      assert.deepEqual(harness.query.setPermissionModeCalls, []);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });
});

describe("ClaudeAdapterLive", () => {
  it.effect("routes Claude resume compaction through the shared user-input UI", () => {
    const harness = makeHarness();

    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: RESUME_THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        resumeCursor: { resume: "550e8400-e29b-41d4-a716-446655440000" },
        runtimeMode: "full-access",
      });

      yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runDrain);

      const onUserDialog = harness.getLastCreateQueryInput()?.options.onUserDialog;
      assert.isTrue(Predicate.isFunction(onUserDialog));

      if (!onUserDialog) return;

      const dialogPromise = onUserDialog(
        {
          dialogKind: "resume_return",
          payload: { sessionAgeMinutes: 145, estimatedTokens: 275123 },
        },
        { signal: new AbortController().signal },
      );

      const requested = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(requested._tag, "Some");

      if (!Predicate.isTagged(requested, "Some") || requested.value.type !== "user-input.requested")
        return;
      const question = requested.value.payload.questions[0];
      assert.equal(question?.header, "Resume session");
      assert.match(question?.question ?? "", /2h 25m/);
      assert.match(question?.question ?? "", /275,123 tokens/);
      assert.deepEqual(
        question?.options.map((option) => option.label),
        ["Compact and continue", "Keep full history", "Don't ask again"],
      );

      if (!question || !requested.value.requestId) return;

      yield* adapter.respondToUserInput(
        session.threadId,
        ApprovalRequestId.make(requested.value.requestId),
        { [question.id]: "Compact and continue" },
      );

      const resolved = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(resolved._tag, "Some");

      if (Predicate.isTagged(resolved, "Some"))
        assert.equal(resolved.value.type, "user-input.resolved");
      assert.deepEqual(yield* Effect.promise(() => dialogPromise), {
        behavior: "completed",
        result: "compact",
      });
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });
});

describe("ClaudeAdapterLive", () => {
  it.effect("handles AskUserQuestion via user-input.requested/resolved lifecycle", () => {
    const harness = makeHarness();

    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      // Start session in approval-required mode so canUseTool fires.
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "approval-required",
      });

      // Drain the session startup events (started, configured, state.changed).
      yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runDrain);

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "question turn",
        attachments: [],
      });
      yield* Stream.take(adapter.streamEvents, 1).pipe(Stream.runDrain);

      harness.query.emit(
        claudeMessage({
          type: "stream_event",
          session_id: "sdk-session-user-input-1",
          uuid: "stream-user-input-thread",
          parent_tool_use_id: null,
          event: {
            type: "message_start",
            message: {
              id: "msg-user-input-thread",
            },
          },
        }),
      );

      const threadStarted = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(threadStarted._tag, "Some");

      if (
        !Predicate.isTagged(threadStarted, "Some") ||
        threadStarted.value.type !== "thread.started"
      ) {
        return;
      }

      const createInput = harness.getLastCreateQueryInput();
      const canUseTool = createInput?.options.canUseTool;
      assert.isTrue(Predicate.isFunction(canUseTool));

      if (!canUseTool) {
        return;
      }

      // Simulate Claude calling AskUserQuestion with structured questions.
      const askInput = {
        questions: [
          {
            question: "Which framework?",
            header: "Framework",
            options: [
              { label: "React", description: "React.js" },
              { label: "Vue", description: "Vue.js" },
            ],
            multiSelect: false,
          },
        ],
      };

      const permissionPromise = canUseTool("AskUserQuestion", askInput, {
        signal: new AbortController().signal,
        toolUseID: "tool-ask-1",
      });

      // The adapter should emit a user-input.requested event.
      const requestedEvent = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(requestedEvent._tag, "Some");

      if (!Predicate.isTagged(requestedEvent, "Some")) {
        return;
      }

      assert.equal(requestedEvent.value.type, "user-input.requested");

      if (requestedEvent.value.type !== "user-input.requested") {
        return;
      }

      const requestId = requestedEvent.value.requestId;
      assert.isTrue(Predicate.isString(requestId));
      assert.equal(requestedEvent.value.payload.questions.length, 1);
      assert.equal(requestedEvent.value.payload.questions[0]?.question, "Which framework?");
      // Regression for #2388: `id` must equal the full question text so the
      // UI's draft-answer key matches what the SDK looks up downstream.
      assert.equal(requestedEvent.value.payload.questions[0]?.id, "Which framework?");
      assert.deepEqual(requestedEvent.value.providerRefs, {
        providerItemId: ProviderItemId.make("tool-ask-1"),
      });

      // Respond with the user's answers.
      yield* adapter.respondToUserInput(session.threadId, ApprovalRequestId.make(requestId!), {
        "Which framework?": "React",
      });

      // The adapter should emit a user-input.resolved event.
      const resolvedEvent = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(resolvedEvent._tag, "Some");

      if (!Predicate.isTagged(resolvedEvent, "Some")) {
        return;
      }

      assert.equal(resolvedEvent.value.type, "user-input.resolved");

      if (resolvedEvent.value.type !== "user-input.resolved") {
        return;
      }

      assert.deepEqual(resolvedEvent.value.payload.answers, {
        "Which framework?": "React",
      });
      assert.deepEqual(resolvedEvent.value.providerRefs, {
        providerItemId: ProviderItemId.make("tool-ask-1"),
      });

      // The canUseTool promise should resolve with the answers in SDK format.
      const permissionResult = yield* Effect.promise(() => permissionPromise);
      assert.equal((permissionResult as PermissionResult).behavior, "allow");

      const updatedInput = (permissionResult as { updatedInput: Schema.JsonObject }).updatedInput;

      assert.deepEqual(updatedInput.answers, { "Which framework?": "React" });
      // Original questions should be passed through.
      assert.deepEqual(updatedInput.questions, askInput.questions);

      // Compatibility check for #2388: the answers shape we hand to the SDK
      // must produce a non-empty rendered tool_result on BOTH SDK iteration
      // patterns we have seen, so we don't regress the issue and we don't
      // break users still on the older Claude CLI.
      const sdkAnswers = updatedInput.answers as Schema.JsonObject;

      const sdkQuestions = updatedInput.questions as ReadonlyArray<{
        readonly question: string;
      }>;

      // Claude CLI 2.1.119 — key-agnostic Object.entries iteration. Any key
      // works here, but it must at least round-trip into a non-empty string.
      const v119Rendered = Object.entries(sdkAnswers)
        .map(([key, value]) => `"${key}"="${String(value)}"`)
        .join(", ");

      assert.equal(v119Rendered, '"Which framework?"="React"');

      // Claude CLI 2.1.121 — lookup by full question text. This is the path
      // that regressed in #2388 when the answers were keyed by `header`.
      const v121Rendered = sdkQuestions
        .map(({ question }) => {
          const answer = sdkAnswers[question];

          return answer === undefined ? null : `"${question}"="${String(answer)}"`;
        })
        .filter((entry): entry is string => entry !== null)
        .join(", ");

      assert.notEqual(v121Rendered, "", "Expected non-empty SDK 2.1.121 tool_result (#2388)");
      assert.equal(v121Rendered, '"Which framework?"="React"');
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });
});
