import {
  ApprovalRequestId,
  CommandId,
  defaultInstanceIdForDriver,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ThreadId,
  ModelSelection,
  type OrchestrationThread,
} from "@akeru/contracts";
import { assert } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type { TestTurnResponse } from "../TestProviderAdapter.integration.ts";
import {
  // oxlint-disable-next-line anti-slop-effect/no-service-constructor-imports -- This integration scenario assembles the isolated orchestration test environment.
  makeOrchestrationIntegrationHarness,
  type OrchestrationIntegrationHarness,
} from "../OrchestrationEngineHarness.integration.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";

export const asMessageId = (value: string): MessageId => MessageId.make(value);

export const asProjectId = (value: string): ProjectId => ProjectId.make(value);

export const asEventId = (value: string): EventId => EventId.make(value);

export const asApprovalRequestId = (value: string): ApprovalRequestId =>
  ApprovalRequestId.make(value);

export const PROJECT_ID = asProjectId("project-1");

export const THREAD_ID = ThreadId.make("thread-1");

export const FIXTURE_TURN_ID = "fixture-turn";

export const APPROVAL_REQUEST_ID = asApprovalRequestId("req-approval-1");

export type IntegrationProvider = ProviderDriverKind;

export const CODEX_PROVIDER = ProviderDriverKind.make("codex");

export const CLAUDE_AGENT_PROVIDER = ProviderDriverKind.make("claudeAgent");

export const GROK_PROVIDER = ProviderDriverKind.make("grok");

export const OPENCODE_GO_PROVIDER = ProviderDriverKind.make("opencodeGo");

export const MASTRA_PROVIDERS = [
  CLAUDE_AGENT_PROVIDER,
  GROK_PROVIDER,
  OPENCODE_GO_PROVIDER,
] as const;

export function modelFor(provider: IntegrationProvider, variant: "a" | "b"): string {
  if (provider === CLAUDE_AGENT_PROVIDER)
    return variant === "a" ? "claude-sonnet-5" : "claude-opus-4-6";

  if (provider === GROK_PROVIDER) return "grok-build";

  return variant === "a" ? "gpt-5.6-luna" : "gpt-5.6-sol";
}

export function mastraFixture(provider: IntegrationProvider, suffix: string): TestTurnResponse {
  const base = (eventId: string, createdAt: string) => ({
    ...runtimeBase(eventId, createdAt, provider),
    threadId: String(THREAD_ID),
    turnId: FIXTURE_TURN_ID,
  });

  return {
    events: [
      { type: "turn.started", ...base(`evt-${suffix}-start`, "2026-05-01T00:00:00.000Z") },
      {
        type: "tool.started",
        ...base(`evt-${suffix}-tool`, "2026-05-01T00:00:00.050Z"),
        title: "fixture tool",
        detail: "echo fixture",
      },
      {
        type: "message.delta",
        ...base(`evt-${suffix}-message`, "2026-05-01T00:00:00.100Z"),
        delta: `${suffix} response\n`,
      },
      {
        type: "turn.completed",
        ...base(`evt-${suffix}-done`, "2026-05-01T00:00:00.150Z"),
        status: "completed",
      },
    ],
  };
}

export function nowIso() {
  return "2026-05-01T00:00:00.000Z";
}

export function observeAfterProviderDrain<A>(
  harness: OrchestrationIntegrationHarness,
  read: () => A,
  predicate: (value: A) => boolean,
  description: string,
) {
  return harness.drainProviderCommands.pipe(
    Effect.andThen(Effect.sync(read)),
    Effect.tap((value) => Effect.sync(() => assert.ok(predicate(value), description))),
  );
}

export function runtimeBase(
  eventId: string,
  createdAt: string,
  provider: IntegrationProvider = CODEX_PROVIDER,
) {
  return {
    eventId: asEventId(eventId),
    provider,
    createdAt,
  };
}

export function withHarness<A, E>(
  use: (harness: OrchestrationIntegrationHarness) => Effect.Effect<A, E>,
  provider: IntegrationProvider = CODEX_PROVIDER,
) {
  return Effect.acquireUseRelease(
    makeOrchestrationIntegrationHarness({ provider }),
    use,
    (harness) => harness.dispose,
  ).pipe(Effect.provide(NodeServices.layer));
}

export function withRealCodexHarness<A, E>(
  use: (harness: OrchestrationIntegrationHarness) => Effect.Effect<A, E>,
) {
  return Effect.acquireUseRelease(
    makeOrchestrationIntegrationHarness({ provider: CODEX_PROVIDER, realCodex: true }),
    use,
    (harness) => harness.dispose,
  ).pipe(Effect.provide(NodeServices.layer));
}

export function assertNoRevertFailure(thread: OrchestrationThread) {
  assert.equal(
    thread.activities.some((activity) => activity.kind === "checkpoint.revert.failed"),
    false,
  );
}

export const seedProjectAndThread = (harness: OrchestrationIntegrationHarness) =>
  Effect.gen(function* () {
    const createdAt = nowIso();
    const provider = harness.adapterHarness?.provider ?? CODEX_PROVIDER;
    const defaultModel = DEFAULT_MODEL_BY_PROVIDER[provider] ?? DEFAULT_MODEL;
    const instanceId = defaultInstanceIdForDriver(provider);

    yield* harness.engine.dispatch({
      type: "project.create",
      commandId: CommandId.make("cmd-project-create"),
      projectId: PROJECT_ID,
      title: "Integration Project",
      workspaceRoot: harness.workspaceDir,
      defaultModelSelection: {
        instanceId,
        model: defaultModel,
      },
      createdAt,
    });

    yield* harness.engine.dispatch({
      type: "thread.create",
      commandId: CommandId.make("cmd-thread-create"),
      threadId: THREAD_ID,
      projectId: PROJECT_ID,
      title: "Integration Thread",
      modelSelection: {
        instanceId,
        model: defaultModel,
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      branch: null,
      worktreePath: harness.workspaceDir,
      createdAt,
    });
  });

export const startTurn = (input: {
  readonly harness: OrchestrationIntegrationHarness;
  readonly commandId: string;
  readonly messageId: string;
  readonly text: string;
  readonly modelSelection?: ModelSelection;
  readonly createdAt?: string;
}) =>
  input.harness.engine.dispatch({
    type: "thread.turn.start",
    commandId: CommandId.make(input.commandId),
    threadId: THREAD_ID,
    message: {
      messageId: asMessageId(input.messageId),
      role: "user",
      text: input.text,
      attachments: [],
    },
    ...(input.modelSelection !== undefined
      ? {
          modelSelection: input.modelSelection,
        }
      : {}),
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    runtimeMode: "approval-required",
    createdAt: input.createdAt ?? nowIso(),
  });
