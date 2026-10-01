import { ThreadId, TurnId } from "@akeru/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import * as Option from "effect/Option";

import { afterEach, describe, expect, it } from "vite-plus/test";
import * as ProviderSessionRuntime from "../../persistence/ProviderSessionRuntime.ts";
import { drainFibers, makeReadModel, createReaperSupport } from "./test-support/sessionReaper.ts";

const support = createReaperSupport();
afterEach(() => support.close());

describe("ProviderSessionReaper", () => {
  it("reaps an idle session through AgentController stop", async () => {
    const threadId = ThreadId.make("thread-reaper-stale");
    const now = "2026-01-01T00:00:00.000Z";
    const harness = await support.createHarness({
      readModel: makeReadModel([
        {
          id: threadId,
          session: {
            threadId,
            status: "ready",
            providerName: "claudeAgent",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: now,
          },
        },
      ]),
    });
    const repository = await support.runtime!.runPromise(
      Effect.service(ProviderSessionRuntime.ProviderSessionRuntimeRepository),
    );

    await support.runtime!.runPromise(
      repository.upsert({
        threadId,
        providerName: "claudeAgent",
        providerInstanceId: null,
        adapterKey: "claudeAgent",
        runtimeMode: "full-access",
        status: "running",
        lastSeenAt: "2026-04-14T00:00:00.000Z",
        resumeCursor: {
          opaque: "resume-stale",
        },
        runtimePayload: null,
      }),
    );

    await support.startReaper();

    await harness.waitForStopCount(1);

    expect(harness.stopSession.mock.calls[0]?.[0]).toEqual({ threadId });
    expect(harness.stoppedThreadIds.has(threadId)).toBe(true);
  });
});

describe("ProviderSessionReaper", () => {
  it("skips stale sessions when the thread still has an active turn", async () => {
    const threadId = ThreadId.make("thread-reaper-active-turn");
    const turnId = TurnId.make("turn-reaper-active");
    const now = "2026-01-01T00:00:00.000Z";
    const harness = await support.createHarness({
      readModel: makeReadModel([
        {
          id: threadId,
          session: {
            threadId,
            status: "running",
            providerName: "claudeAgent",
            runtimeMode: "full-access",
            activeTurnId: turnId,
            lastError: null,
            updatedAt: now,
          },
        },
      ]),
    });
    const repository = await support.runtime!.runPromise(
      Effect.service(ProviderSessionRuntime.ProviderSessionRuntimeRepository),
    );

    await support.runtime!.runPromise(
      repository.upsert({
        threadId,
        providerName: "claudeAgent",
        providerInstanceId: null,
        adapterKey: "claudeAgent",
        runtimeMode: "full-access",
        status: "running",
        lastSeenAt: "2026-04-14T00:00:00.000Z",
        resumeCursor: {
          opaque: "resume-active-turn",
        },
        runtimePayload: null,
      }),
    );

    await support.startReaper();
    await Effect.runPromise(drainFibers);

    expect(harness.stopSession).not.toHaveBeenCalled();
    const remaining = await support.runtime!.runPromise(repository.getByThreadId({ threadId }));
    expect(Option.isSome(remaining)).toBe(true);
  });
});

describe("ProviderSessionReaper", () => {
  it("skips stale sessions while background work is still live", async () => {
    const threadId = ThreadId.make("thread-reaper-background-work");
    const now = "2026-01-01T00:00:00.000Z";
    const harness = await support.createHarness({
      readModel: makeReadModel([
        {
          id: threadId,
          session: {
            threadId,
            status: "ready",
            providerName: "claudeAgent",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: now,
          },
          backgroundLiveness: "working",
        },
      ]),
    });
    const repository = await support.runtime!.runPromise(
      Effect.service(ProviderSessionRuntime.ProviderSessionRuntimeRepository),
    );

    await support.runtime!.runPromise(
      repository.upsert({
        threadId,
        providerName: "claudeAgent",
        providerInstanceId: null,
        adapterKey: "claudeAgent",
        runtimeMode: "full-access",
        status: "running",
        lastSeenAt: "2026-04-14T00:00:00.000Z",
        resumeCursor: {
          opaque: "resume-background-work",
        },
        runtimePayload: null,
      }),
    );

    await support.startReaper();
    await Effect.runPromise(drainFibers);

    expect(harness.stopSession).not.toHaveBeenCalled();
    const remaining = await support.runtime!.runPromise(repository.getByThreadId({ threadId }));
    expect(Option.isSome(remaining)).toBe(true);
  });
});

describe("ProviderSessionReaper", () => {
  it("does not reap sessions that are still within the inactivity threshold", async () => {
    const threadId = ThreadId.make("thread-reaper-fresh");
    const now = DateTime.formatIso(await Effect.runPromise(DateTime.now));
    const harness = await support.createHarness({
      readModel: makeReadModel([
        {
          id: threadId,
          session: {
            threadId,
            status: "ready",
            providerName: "claudeAgent",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: now,
          },
        },
      ]),
    });
    const repository = await support.runtime!.runPromise(
      Effect.service(ProviderSessionRuntime.ProviderSessionRuntimeRepository),
    );

    await support.runtime!.runPromise(
      repository.upsert({
        threadId,
        providerName: "claudeAgent",
        providerInstanceId: null,
        adapterKey: "claudeAgent",
        runtimeMode: "full-access",
        status: "running",
        lastSeenAt: now,
        resumeCursor: {
          opaque: "resume-fresh",
        },
        runtimePayload: null,
      }),
    );

    await support.startReaper();
    await Effect.runPromise(drainFibers);

    expect(harness.stopSession).not.toHaveBeenCalled();
    const remaining = await support.runtime!.runPromise(repository.getByThreadId({ threadId }));
    expect(Option.isSome(remaining)).toBe(true);
  });
});

describe("ProviderSessionReaper", () => {
  it.each(["ready", "interrupted", "error"] as const)(
    "gives a long turn a full idle window after becoming %s",
    async (status) => {
      const threadId = ThreadId.make(`thread-reaper-long-turn-${status}`);
      const startedAt = "2026-04-14T00:00:00.000Z";
      const completedAt = "2026-04-14T01:00:00.000Z";
      const completedAtMs = Date.parse(completedAt);
      const harness = await support.createHarness({
        readModel: makeReadModel([
          {
            id: threadId,
            session: {
              threadId,
              status,
              providerName: "claudeAgent",
              runtimeMode: "full-access",
              activeTurnId: null,
              lastError: null,
              updatedAt: completedAt,
            },
          },
        ]),
      });
      const repository = await support.runtime!.runPromise(
        Effect.service(ProviderSessionRuntime.ProviderSessionRuntimeRepository),
      );
      await support.runtime!.runPromise(
        repository.upsert({
          threadId,
          providerName: "claudeAgent",
          providerInstanceId: null,
          adapterKey: "claudeAgent",
          runtimeMode: "full-access",
          status: "running",
          lastSeenAt: startedAt,
          resumeCursor: { opaque: "resume-long-turn" },
          runtimePayload: null,
        }),
      );

      await support.sweepAt(completedAtMs);
      expect(harness.stopSession).not.toHaveBeenCalled();
      await support.sweepAt(completedAtMs + 999);
      expect(harness.stopSession).not.toHaveBeenCalled();
      await support.sweepAt(completedAtMs + 1_000);
      expect(harness.stopSession).toHaveBeenCalledTimes(1);
      expect(harness.stopSession).toHaveBeenCalledWith({ threadId });
    },
  );
});

describe("ProviderSessionReaper", () => {
  it.each([true, false])(
    "uses the binding idle window when the session is older or missing, hasSession=%s",
    async (hasSession) => {
      const threadId = ThreadId.make("thread-reaper-fresh");
      const now = "2026-04-14T01:00:00.000Z";
      const nowMs = Date.parse(now);
      const harness = await support.createHarness({
        readModel: makeReadModel([
          {
            id: threadId,
            session: hasSession
              ? {
                  threadId,
                  status: "ready",
                  providerName: "claudeAgent",
                  runtimeMode: "full-access",
                  activeTurnId: null,
                  lastError: null,
                  updatedAt: "2026-04-14T00:00:00.000Z",
                }
              : null,
          },
        ]),
      });
      const repository = await support.runtime!.runPromise(
        Effect.service(ProviderSessionRuntime.ProviderSessionRuntimeRepository),
      );
      await support.runtime!.runPromise(
        repository.upsert({
          threadId,
          providerName: "claudeAgent",
          providerInstanceId: null,
          adapterKey: "claudeAgent",
          runtimeMode: "full-access",
          status: "running",
          lastSeenAt: now,
          resumeCursor: { opaque: "resume-fresh" },
          runtimePayload: null,
        }),
      );

      await support.sweepAt(nowMs + 999);
      expect(harness.stopSession).not.toHaveBeenCalled();
      await support.sweepAt(nowMs + 1_000);
      expect(harness.stopSession).toHaveBeenCalledTimes(1);
      expect(harness.stopSession).toHaveBeenCalledWith({ threadId });
    },
  );
});
