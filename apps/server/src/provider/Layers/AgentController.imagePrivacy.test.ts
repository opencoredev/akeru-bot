import type { AgentControllerEvent } from "@mastra/core/agent-controller";
import { ApprovalRequestId, ProviderDriverKind, type ProviderRuntimeEvent } from "@akeru/contracts";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import { assert, describe, expect, vi } from "vite-plus/test";
import { partialSdkFixture } from "../test-support/partialSdkFixture.ts";
import { runtimeEventToActivities } from "../../orchestration/Layers/runtime-ingestion/ActivityMapping.ts";
import { type EntityMemoryRepositoryShape } from "../../memory/Services/EntityMemoryRepository.ts";
import { AgentController } from "../Services/AgentController.ts";
import {
  codexThreadId,
  codexInstanceId,
  codexSelection,
} from "./test-support/agentControllerFixtures.ts";
import {
  makeBridge,
  provideController,
  resolveCodex,
} from "./test-support/agentControllerLayers.ts";
import { mastraHarnessFixture } from "./test-support/agentControllerHarness.ts";

const PROMPT = "Private launch poster prompt that must not be persisted";

const INPUT_IMAGE_ID = "chat-image-1";

type DerivedCopiesInput = Parameters<
  NonNullable<EntityMemoryRepositoryShape["recordDerivedCopies"]>
>[0];

type InsertInput = Parameters<EntityMemoryRepositoryShape["insert"]>[0];

type InsertScopedFactInput = Parameters<EntityMemoryRepositoryShape["insertScopedFact"]>[0];

type ApplyMutationInput = Parameters<EntityMemoryRepositoryShape["applyMutation"]>[0];

const collectEvents = (events: ProviderRuntimeEvent[], controller: AgentController["Service"]) =>
  controller.streamEvents.pipe(
    Stream.runForEach((event) => Effect.sync(() => events.push(event))),
    Effect.forkChild({ startImmediately: true }),
  );

const startCodex = (controller: AgentController["Service"]) =>
  Effect.gen(function* () {
    yield* resolveCodex(controller);
    yield* controller.startSession(codexThreadId, {
      threadId: codexThreadId,
      provider: ProviderDriverKind.make("codex"),
      providerInstanceId: codexInstanceId,
      cwd: process.cwd(),
      modelSelection: codexSelection,
      runtimeMode: "full-access",
    });
  });

describe("AgentControllerLive image privacy", () => {
  it.effect("bounds prompts and input images on tool events and records provider consent", () => {
    const bridge = makeBridge();
    const mastra = mastraHarnessFixture();
    const entityWrites: unknown[] = [];

    const entityMemory = partialSdkFixture<EntityMemoryRepositoryShape>({
      listCurrent: vi.fn(() => Effect.succeed([])),
      search: vi.fn(() => Effect.succeed([])),
      recordDerivedCopies: vi.fn((input: DerivedCopiesInput) => {
        entityWrites.push(input);

        return Effect.void;
      }),
      insert: vi.fn((input: InsertInput) => {
        entityWrites.push(input);

        return Effect.die(new Error("unexpected entity-memory write"));
      }),
      insertScopedFact: vi.fn((input: InsertScopedFactInput) => {
        entityWrites.push(input);

        return Effect.die(new Error("unexpected entity-memory write"));
      }),
      applyMutation: vi.fn((input: ApplyMutationInput) => {
        entityWrites.push(input);

        return Effect.die(new Error("unexpected entity-memory write"));
      }),
    });

    return provideController(
      Effect.gen(function* () {
        const controller = yield* AgentController;
        const events: ProviderRuntimeEvent[] = [];
        const collector = yield* collectEvents(events, controller);
        yield* Effect.yieldNow;
        yield* startCodex(controller);
        yield* controller.sendTurn({ threadId: codexThreadId, input: "Make an image." });

        const consentArgs = {
          operation: "edit",
          prompt: PROMPT,
          inputImages: [INPUT_IMAGE_ID],
          allowProvider: "grok",
        };

        mastra.emit({
          type: "tool_start",
          toolCallId: "image-call-1",
          toolName: "GenerateImage",
          args: consentArgs,
        } as AgentControllerEvent);
        mastra.emit({
          type: "tool_approval_required",
          toolCallId: "image-call-1",
          toolName: "GenerateImage",
          args: consentArgs,
        } as AgentControllerEvent);
        yield* Effect.yieldNow;

        const itemStarted = events.find(
          (event) => event.type === "item.started" && String(event.itemId) === "image-call-1",
        );

        assert.isDefined(itemStarted);

        if (itemStarted?.type === "item.started") {
          const data = itemStarted.payload.data as { args?: unknown } | undefined;
          assert.deepEqual(data?.args, { operation: "edit", allowProvider: "grok" });
        }

        const opened = events.find((event) => event.type === "request.opened");
        assert.isDefined(opened);

        if (opened?.type === "request.opened") {
          assert.equal(opened.payload.detail, "Send the chat images to Grok?");
          assert.deepEqual(opened.payload.args, {
            operation: "edit",
            allowProvider: "grok",
          });
        }

        const [approvalActivity] = opened ? runtimeEventToActivities(opened) : [];
        assert.isDefined(approvalActivity);
        assert.equal(approvalActivity.kind, "approval.requested");
        assert.equal(approvalActivity.tone, "approval");
        assert.deepEqual((approvalActivity.payload as { args?: unknown }).args, {
          operation: "edit",
          allowProvider: "grok",
        });
        assert.equal(
          (approvalActivity.payload as { detail?: unknown }).detail,
          "Send the chat images to Grok?",
        );

        yield* controller.respondToRequest({
          threadId: codexThreadId,
          requestId: ApprovalRequestId.make("image-call-1"),
          decision: "accept",
        });
        yield* Effect.yieldNow;

        const resolved = events.find(
          (event) =>
            event.type === "request.resolved" && String(event.requestId) === "image-call-1",
        );

        assert.isDefined(resolved);

        if (resolved?.type === "request.resolved") {
          expect(resolved.payload).toMatchObject({
            decision: "accept",
            actor: "user",
            outcome: "approved",
          });
        }

        const stored = JSON.stringify(events) + JSON.stringify(entityWrites);
        assert.equal(stored.includes(PROMPT), false);
        assert.equal(stored.includes(INPUT_IMAGE_ID), false);

        mastra.finishSend();
        yield* Fiber.interrupt(collector);
      }),
      bridge.service,
      mastra.factory,
      undefined,
      undefined,
      undefined,
      { entityMemoryRepository: entityMemory },
    );
  });

  it.effect("bounds image prompts on a plain generate approval without naming a provider", () => {
    const bridge = makeBridge();
    const mastra = mastraHarnessFixture();

    return provideController(
      Effect.gen(function* () {
        const controller = yield* AgentController;
        const events: ProviderRuntimeEvent[] = [];
        const collector = yield* collectEvents(events, controller);
        yield* Effect.yieldNow;
        yield* startCodex(controller);
        yield* controller.sendTurn({ threadId: codexThreadId, input: "Make an image." });

        mastra.emit({
          type: "tool_approval_required",
          toolCallId: "image-call-2",
          toolName: "GenerateImage",
          args: { operation: "generate", prompt: PROMPT, count: 1 },
        } as AgentControllerEvent);
        yield* Effect.yieldNow;

        const opened = events.find(
          (event) => event.type === "request.opened" && String(event.requestId) === "image-call-2",
        );

        assert.isDefined(opened);

        if (opened?.type === "request.opened") {
          assert.equal(
            opened.payload.detail,
            "Approve this action with GenerateImage? This approval applies only to the pending action. It cannot undo completed work.",
          );
          assert.deepEqual(opened.payload.args, { operation: "generate", count: 1 });
          assert.equal(opened.payload.options?.length, 2);
        }

        assert.equal(JSON.stringify(events).includes(PROMPT), false);

        mastra.finishSend();
        yield* Fiber.interrupt(collector);
      }),
      bridge.service,
      mastra.factory,
    );
  });

  it.effect("leaves non-image tool args intact", () => {
    const bridge = makeBridge();
    const mastra = mastraHarnessFixture();

    return provideController(
      Effect.gen(function* () {
        const controller = yield* AgentController;
        const events: ProviderRuntimeEvent[] = [];
        const collector = yield* collectEvents(events, controller);
        yield* Effect.yieldNow;
        yield* startCodex(controller);
        yield* controller.sendTurn({ threadId: codexThreadId, input: "Run pwd." });

        mastra.emit({
          type: "tool_start",
          toolCallId: "shell-call-1",
          toolName: "Shell",
          args: { command: "pwd" },
        } as AgentControllerEvent);
        mastra.emit({
          type: "tool_approval_required",
          toolCallId: "shell-call-1",
          toolName: "Shell",
          args: { command: "pwd" },
        } as AgentControllerEvent);
        yield* Effect.yieldNow;

        const itemStarted = events.find(
          (event) => event.type === "item.started" && String(event.itemId) === "shell-call-1",
        );

        if (itemStarted?.type === "item.started") {
          const data = itemStarted.payload.data as { args?: unknown } | undefined;
          assert.deepEqual(data?.args, { command: "pwd" });
        }

        const opened = events.find(
          (event) => event.type === "request.opened" && String(event.requestId) === "shell-call-1",
        );

        if (opened?.type === "request.opened") {
          assert.deepEqual(opened.payload.args, { command: "pwd" });
        }

        mastra.finishSend();
        yield* Fiber.interrupt(collector);
      }),
      bridge.service,
      mastra.factory,
    );
  });
});
