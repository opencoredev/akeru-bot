import * as NodeCrypto from "node:crypto";
import {
  BotId,
  CommandId,
  MessageId,
  type ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ChannelBinding,
  type ChannelProvider,
  type OrchestrationReadModel,
} from "@akeru/contracts";
import { type Message, type Thread } from "chat";
import * as Effect from "effect/Effect";
import { failWith } from "./ChannelErrors.ts";
import {
  type InboundChannelMessage,
  type LiveProvider,
  type ChannelRuntimeContext,
} from "./ChannelRuntimeTypes.ts";
import { randomId } from "./ChannelSecrets.ts";
import { replaceBinding } from "./ChannelOperations.ts";

export const CHANNEL_MENTION_CONTEXT_LIMIT = 10;

export const CHANNEL_MENTION_CONTEXT_CHARACTER_LIMIT = 8_000;

export const channelThreadId = (
  botId: BotId,
  projectId: ProjectId,
  provider: LiveProvider,
  externalThreadId: string,
): ThreadId =>
  ThreadId.make(
    `channel-${NodeCrypto.createHash("sha256")
      .update(`${botId}\0${projectId}\0${provider}\0${externalThreadId}`)
      .digest("hex")}`,
  );

export const legacyChannelThreadId = (
  botId: BotId,
  provider: LiveProvider,
  externalThreadId: string,
): ThreadId =>
  ThreadId.make(
    `channel-${NodeCrypto.createHash("sha256")
      .update(`${botId}\0${provider}\0${externalThreadId}`)
      .digest("hex")}`,
  );

export const deterministicChannelId = (
  prefix: string,
  input: {
    readonly botId: BotId;
    readonly projectId: ProjectId;
    readonly provider: ChannelProvider;
    readonly externalThreadId: string;
    readonly externalMessageId: string;
  },
) =>
  `${prefix}-${NodeCrypto.createHash("sha256")
    .update(
      `${input.botId}\0${input.projectId}\0${input.provider}\0${input.externalThreadId}\0${input.externalMessageId}`,
    )
    .digest("hex")}`;

export const normalizedInboundMessage = (
  thread: Pick<Thread, "id" | "recentMessages" | "refresh">,
  message: Message,
  text = message.text,
): InboundChannelMessage => ({
  externalThreadId: thread.id,
  externalMessageId: message.id,
  externalSenderId: message.author.userId,
  externalSenderName: message.author.fullName || message.author.userName,
  text,
});

export async function mentionWithContext(
  thread: Pick<Thread, "id" | "recentMessages" | "refresh">,
  message: Message,
): Promise<InboundChannelMessage> {
  await thread.refresh().catch(() => undefined);

  const context = thread.recentMessages
    .filter(
      (candidate) =>
        candidate.id !== message.id &&
        candidate.author.isBot !== true &&
        candidate.author.isMe !== true &&
        candidate.text.trim(),
    )
    .slice(-CHANNEL_MENTION_CONTEXT_LIMIT)
    .map(
      (candidate) =>
        `${candidate.author.fullName || candidate.author.userName || candidate.author.userId}: ${candidate.text}`,
    );

  const boundedContext = context.join("\n").slice(-CHANNEL_MENTION_CONTEXT_CHARACTER_LIMIT);

  return normalizedInboundMessage(
    thread,
    message,
    boundedContext.length === 0 ? message.text : `${boundedContext}\n${message.text}`,
  );
}

export const subscribedExternalThreadIds = (
  ctx: ChannelRuntimeContext,
  model: OrchestrationReadModel,
  botId: BotId,
  projectId: ProjectId,
  provider: ChannelProvider,
) =>
  Effect.gen(function* () {
    const candidateIds = model.threads.flatMap((thread) =>
      thread.botId === botId &&
      thread.projectId === projectId &&
      thread.groupId === null &&
      thread.deletedAt === null
        ? [thread.id]
        : [],
    );

    const threads = yield* Effect.forEach(candidateIds, ctx.deps.readThread, {
      concurrency: "unbounded",
    });

    const ids = new Set<string>();

    for (const thread of threads) {
      if (!thread) continue;

      for (const message of thread.messages) {
        if (message.channelOrigin?.provider === provider) {
          ids.add(message.channelOrigin.externalThreadId);
        }
      }
    }

    return [...ids];
  });

/**
 * Marks connected bindings whose transport is not running, and `connecting` bindings with no
 * start in flight (left by a crash mid-connect), as needing a reconnect.
 */
export function channelBindingsForRuntime(
  bindings: ReadonlyArray<ChannelBinding>,
  isRunning: (botId: BotId, provider: ChannelProvider) => boolean,
  isConnecting: (botId: BotId, provider: ChannelProvider) => boolean = () => false,
): ReadonlyArray<ChannelBinding> {
  // A not-live WhatsApp binding still runs a transport that can send, so it needs one too.
  return bindings.map((binding) =>
    ((binding.status === "connected" || binding.status === "not-live") &&
      !isRunning(binding.botId, binding.provider)) ||
    (binding.status === "connecting" && !isConnecting(binding.botId, binding.provider))
      ? { ...binding, status: "needs-reconnect" }
      : binding,
  );
}

export interface InboundDispatchInput extends InboundChannelMessage {
  readonly botId: BotId;
  readonly projectId: ProjectId;
  readonly provider: LiveProvider;
}

export const dispatchInboundChannelMessage = (
  ctx: ChannelRuntimeContext,
  input: InboundDispatchInput,
) => {
  const deps = ctx.deps;

  const preferredThreadId = channelThreadId(
    input.botId,
    input.projectId,
    input.provider,
    input.externalThreadId,
  );

  return ctx.withLock(`inbound:${preferredThreadId}`)(
    Effect.gen(function* () {
      const model = yield* deps.readModel;

      const bot = model.bots.find(
        (candidate) => candidate.id === input.botId && candidate.archivedAt === null,
      );

      if (!bot) return yield* failWith(`Bot '${input.botId}' is unavailable.`);

      const project = model.projects.find(
        (candidate) => candidate.id === input.projectId && candidate.deletedAt === null,
      );

      if (!project) {
        const binding = bot.channelBindings.find(
          (entry) => entry.provider === input.provider && entry.projectId === input.projectId,
        );

        if (binding) {
          yield* Effect.gen(function* () {
            yield* replaceBinding(ctx, {
              ...binding,
              status: "blocked",
              lastAttemptAt: yield* deps.nowIso,
              lastError: "The selected project is unavailable. Choose another project.",
            });
          }).pipe(Effect.ignoreCause);
        }

        return yield* failWith("The channel project is unavailable.");
      }

      const modelSelection = bot.engine
        ? {
            instanceId: ProviderInstanceId.make(bot.engine.provider),
            model: bot.engine.model,
            ...(bot.engine.options ? { options: bot.engine.options } : {}),
          }
        : project.defaultModelSelection;

      if (!modelSelection)
        return yield* failWith(`Bot '${bot.name}' needs a model before channel messages.`);

      const legacyThreadId = legacyChannelThreadId(
        input.botId,
        input.provider,
        input.externalThreadId,
      );

      const existing = model.threads.find(
        (thread) =>
          (thread.id === preferredThreadId || thread.id === legacyThreadId) &&
          thread.projectId === input.projectId &&
          thread.deletedAt === null,
      );

      const threadId = existing?.id ?? preferredThreadId;
      const createdAt = yield* deps.nowIso;

      if (!existing) {
        yield* deps.engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`channel-create-${threadId}`),
          threadId,
          projectId: project.id,
          botId: bot.id,
          groupId: null,
          title: bot.name,
          modelSelection,
          runtimeMode: bot.runtimeMode,
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt,
        });
      } else if (
        existing.botId !== bot.id ||
        existing.groupId != null ||
        existing.projectId !== project.id
      ) {
        return yield* failWith(`Channel thread '${threadId}' belongs to another owner.`);
      }

      const deterministicInput = input.externalMessageId
        ? {
            botId: input.botId,
            projectId: input.projectId,
            provider: input.provider,
            externalThreadId: input.externalThreadId,
            externalMessageId: input.externalMessageId,
          }
        : null;

      const commandId = CommandId.make(
        deterministicInput
          ? deterministicChannelId("channel-turn", deterministicInput)
          : yield* randomId(ctx, "channel-turn"),
      );

      const messageId = MessageId.make(
        deterministicInput
          ? deterministicChannelId("channel-message", deterministicInput)
          : yield* randomId(ctx, "channel-message"),
      );

      yield* deps.engine.dispatch({
        type: "thread.turn.start",
        commandId,
        threadId,
        message: {
          messageId,
          role: "user",
          text: input.text,
          attachments: [],
          channelOrigin: {
            provider: input.provider,
            externalThreadId: input.externalThreadId,
            ...(input.externalMessageId ? { externalMessageId: input.externalMessageId } : {}),
            ...(input.externalSenderId ? { externalSenderId: input.externalSenderId } : {}),
          },
        },
        ...(input.externalSenderName ? { senderDisplayName: input.externalSenderName } : {}),
        modelSelection,
        runtimeMode: bot.runtimeMode,
        interactionMode: "default",
        createdAt,
      });
    }),
  );
};
