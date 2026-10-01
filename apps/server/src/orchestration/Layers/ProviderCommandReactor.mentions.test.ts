import { ProviderInstanceId } from "@akeru/contracts";
import { CommandId, DEFAULT_PROVIDER_INTERACTION_MODE, ThreadId } from "@akeru/contracts";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  asMessageId,
  asProjectId,
  createProviderCommandHarness,
} from "./test-support/ProviderCommandHarness.ts";

describe("ProviderCommandReactor", () => {
  const testScope = createProviderCommandHarness();
  const { createHarness } = testScope;
  afterEach(testScope.dispose);
  it.each([
    { enableAgentBrowserAccess: true, browserText: "preview browser tools" },
    { enableAgentBrowserAccess: false, browserText: "turned off in Settings" },
  ])(
    "expands @browser and @chat: mentions into bounded provider context (browser access $enableAgentBrowserAccess)",
    async ({ enableAgentBrowserAccess, browserText }) => {
      const harness = await createHarness({ enableAgentBrowserAccess });
      const now = "2026-01-01T00:00:00.000Z";

      const startTurn = (threadId: string, messageId: string, text: string) =>
        harness.run(
          harness.engine.dispatch({
            type: "thread.turn.start",
            commandId: CommandId.make(`cmd-${messageId}`),
            threadId: ThreadId.make(threadId),
            message: { messageId: asMessageId(messageId), role: "user", text, attachments: [] },
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            runtimeMode: "approval-required",
            createdAt: now,
          }),
        );

      await harness.run(
        harness.engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd-thread-create-mentioned"),
          threadId: ThreadId.make("thread-2"),
          projectId: asProjectId("project-1"),
          title: "Release plan",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          createdAt: now,
        }),
      );
      await startTurn("thread-2", "mentioned-message", "ship the release on friday");
      await harness.waitFor(() => harness.sendTurn.mock.calls.length === 1);

      const prompt = "check @chat:thread-2 with @browser";
      await startTurn("thread-1", "mentioning-message", prompt);
      await harness.waitFor(() => harness.sendTurn.mock.calls.length === 2);

      const sent = harness.sendTurn.mock.calls[1]?.[0] as { readonly input?: string };
      expect(sent.input?.startsWith(`${prompt}\n\n<mention_context>`)).toBe(true);
      expect(sent.input).toContain(browserText);
      expect(sent.input).toContain(
        '<chat_context id="thread-2" title="Release plan">\nUser: ship the release on friday\n</chat_context>',
      );

      const readModel = await harness.readModel();
      const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      expect(thread?.messages.at(-1)?.text).toBe(prompt);
    },
  );

  it("never expands archived, deleted, background, or unknown chats", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    const dispatch = (command: Parameters<typeof harness.engine.dispatch>[0]) =>
      harness.run(harness.engine.dispatch(command));

    const createWithMessage = async (threadId: string, title: string, sent: number) => {
      await dispatch({
        type: "thread.create",
        commandId: CommandId.make(`cmd-create-${threadId}`),
        threadId: ThreadId.make(threadId),
        projectId: asProjectId("project-1"),
        title,
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt: now,
      });
      await dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make(`cmd-turn-${threadId}`),
        threadId: ThreadId.make(threadId),
        message: {
          messageId: asMessageId(`message-${threadId}`),
          role: "user",
          text: `secret from ${title}`,
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      });
      await harness.waitFor(() => harness.sendTurn.mock.calls.length === sent);
    };

    await createWithMessage("thread-archived", "Archived plan", 1);
    await createWithMessage("thread-deleted", "Deleted plan", 2);
    await createWithMessage("delegation-thread-worker", "Background work", 3);
    await dispatch({
      type: "thread.archive",
      commandId: CommandId.make("cmd-archive"),
      threadId: ThreadId.make("thread-archived"),
    });
    await dispatch({
      type: "thread.delete",
      commandId: CommandId.make("cmd-delete"),
      threadId: ThreadId.make("thread-deleted"),
    });

    // Four excluded mentions come first, so a valid fifth one needs a free context slot.
    await createWithMessage("thread-visible", "Visible plan", 4);

    const prompt =
      "see @chat:thread-archived @chat:thread-deleted @chat:delegation-thread-worker @chat:thread-missing @chat:thread-visible";

    await dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make("cmd-turn-mentioning"),
      threadId: ThreadId.make("thread-1"),
      message: {
        messageId: asMessageId("message-mentioning"),
        role: "user",
        text: prompt,
        attachments: [],
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      createdAt: now,
    });
    await harness.waitFor(() => harness.sendTurn.mock.calls.length === 5);

    const sent = harness.sendTurn.mock.calls[4]?.[0] as { readonly input?: string };
    expect(sent.input).toContain("secret from Visible plan");
    expect(sent.input).not.toContain("secret from Archived plan");
    expect(sent.input).not.toContain("secret from Deleted plan");
    expect(sent.input).not.toContain("secret from Background work");
  });

  it("runs a thread stored in the retired plan mode as a default turn", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await harness.run(
      harness.engine.dispatch({
        type: "thread.interaction-mode.set",
        commandId: CommandId.make("cmd-interaction-mode-set-plan"),
        threadId: ThreadId.make("thread-1"),
        interactionMode: "plan",
        createdAt: now,
      }),
    );

    await harness.run(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-plan"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-plan"),
          role: "user",
          text: "plan this change",
          attachments: [],
        },
        interactionMode: "plan",
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await harness.waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
      interactionMode: "default",
    });
  });
});
