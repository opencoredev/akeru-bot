import { ModelSelection, ProviderInstanceId } from "@akeru/contracts";
import { CommandId, DEFAULT_PROVIDER_INTERACTION_MODE, ThreadId } from "@akeru/contracts";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  asMessageId,
  createProviderCommandHarness,
} from "./test-support/ProviderCommandHarness.ts";

describe("ProviderCommandReactor", () => {
  const testScope = createProviderCommandHarness();

  const { createHarness } = testScope;

  afterEach(testScope.dispose);

  it("reacts to thread.session.stop by stopping provider session and clearing thread session state", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-for-stop"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex_work"),
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.session.stop",
        commandId: CommandId.make("cmd-session-stop"),
        threadId: ThreadId.make("thread-1"),
        createdAt: now,
      }),
    );

    await harness.waitFor(() => harness.stopSession.mock.calls.length === 1);
    await harness.drain();
    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.session).not.toBeNull();
    expect(thread?.session?.status).toBe("stopped");
    expect(thread?.session?.threadId).toBe("thread-1");
    expect(thread?.session?.providerInstanceId).toBe(ProviderInstanceId.make("codex_work"));
    expect(thread?.session?.activeTurnId).toBeNull();
  });

  it("routes two bots on the same provider instance to their own saved models", async () => {
    const harness = await createHarness({
      botEngine: { provider: "codex", model: "gpt-5.6-sol" },
      secondBot: { engine: { provider: "codex", model: "gpt-5.6-codex-mini" } },
    });

    const now = "2026-01-01T00:00:00.000Z";

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-bot-1-model"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-bot-1-model"),
          role: "user",
          text: "bot one turn",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-bot-2-model"),
        threadId: ThreadId.make("thread-2"),
        message: {
          messageId: asMessageId("user-message-bot-2-model"),
          role: "user",
          text: "bot two turn",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await harness.waitFor(() => harness.sendTurn.mock.calls.length === 2);
    await harness.drain();

    const sessionModels = Object.fromEntries(
      harness.startSession.mock.calls.map((call) => [
        String((call[1] as { threadId: ThreadId }).threadId),
        (call[1] as { modelSelection?: ModelSelection }).modelSelection,
      ]),
    );

    expect(sessionModels["thread-1"]).toMatchObject({
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.6-sol",
    });
    expect(sessionModels["thread-2"]).toMatchObject({
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.6-codex-mini",
    });

    const turnModels = Object.fromEntries(
      harness.sendTurn.mock.calls.map((call) => [
        String((call[0] as { threadId: ThreadId }).threadId),
        (call[0] as { modelSelection?: ModelSelection }).modelSelection,
      ]),
    );

    expect(turnModels["thread-1"]).toMatchObject({ model: "gpt-5.6-sol" });
    expect(turnModels["thread-2"]).toMatchObject({ model: "gpt-5.6-codex-mini" });
  });
});
