import {
  type BotId,
  CHANNEL_OWNER_PROVIDERS,
  type ChannelOwnerIdentity,
  type ChannelProvider,
  DISCORD_OWNER_WORKSPACE_ID,
  type OrchestrationReadModel,
  type ProjectId,
  type ServerSettings,
} from "@akeru/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { failWith } from "./ChannelErrors.ts";
import { replaceBinding, withAccessLane, withChannelOperation } from "./ChannelOperations.ts";
import { runtimeKey } from "./ChannelSecrets.ts";
import {
  SLACK_LINK_USERS_READ_MISSING,
  SLACK_USERS_READ_MISSING,
} from "./ChannelSlackMembership.ts";
import {
  CHANNEL_ADMITTED_MESSAGE_RETENTION_MS,
  type ChannelFollowKey,
} from "./ChannelFollowStore.ts";
import {
  type ChannelAccessSetInput,
  type ChannelGateDecision,
  type ChannelGateInput,
  type ChannelLinkCodeCreateInput,
  type ChannelOwnerRemoveInput,
  type ChannelRuntimeContext,
  type ChannelSenderMembership,
  type PendingChannelLinkCode,
} from "./ChannelRuntimeTypes.ts";

export const CHANNEL_LINK_CODE_TTL = Duration.minutes(10);

/** A follow ends when the owner has not written in the thread for this long. */
export const CHANNEL_FOLLOW_IDLE_LIMIT = Duration.hours(24);

export const CHANNEL_LINK_INSTRUCTIONS =
  "This bot is not linked to its owner yet. In Akeru, open Settings > Channels, create a link code for this bot, and send me the code in a direct message.";

export const CHANNEL_LINK_INVALID =
  "That link code is not valid. A code works once and expires after 10 minutes. Create a new one in Akeru Settings > Channels.";

export const CHANNEL_LINK_EXTERNAL = "Only people in this bot's own workspace can link it.";

export const CHANNEL_STOP_REPLY = "OK, I stopped following this thread. Mention me to start again.";

export const channelLinkedReply = (botName: string) =>
  `Linked. ${botName} now answers you here, and in threads after you mention it.`;

export const channelOthersReply = (ownerName: string | undefined) =>
  ownerName ? `This is ${ownerName}'s bot.` : "This bot only answers its owner.";

/** ISO text for an epoch time, in the form the stores compare. */
const isoAt = (epochMillis: number) => DateTime.formatIso(DateTime.makeUnsafe(epochMillis));

const LINK_CODE_PATTERN = /^[A-HJ-NP-Z2-9]{8}$/u;

const STOP_PATTERN = /^stop[.!]?$/iu;

const ignore: ChannelGateDecision = { type: "ignore" };

const reply = (text: string, unsubscribe?: boolean): ChannelGateDecision => ({
  type: "reply",
  text,
  ...(unsubscribe ? { unsubscribe } : {}),
});

/** Providers whose bots answer only linked people. DM-only providers keep their direct policy. */
export const isOwnerGatedProvider = (provider: ChannelProvider): provider is "slack" | "discord" =>
  provider === "slack" || provider === "discord";

const homeWorkspace = (provider: ChannelProvider, input: ChannelGateInput) =>
  provider === "discord" ? DISCORD_OWNER_WORKSPACE_ID : input.homeWorkspaceId;

/** The sender's workspace as the platform confirms it. A failed lookup confirms nothing. */
const verifiedSenderWorkspace = (input: ChannelGateInput) =>
  Effect.promise(
    (): Promise<ChannelSenderMembership> =>
      input.sender.verifiedWorkspace().catch(() => ({ kind: "unconfirmed" })),
  );

/**
 * Platform user IDs of the other Akeru bots connected to this provider. Slack stores the bot user
 * ID as the identity; Discord stores `name (id)`.
 */
export const otherChannelBotUserIds = (
  model: OrchestrationReadModel,
  botId: BotId,
  provider: ChannelProvider,
): ReadonlySet<string> =>
  new Set(
    model.bots.flatMap((bot) =>
      bot.id === botId || bot.archivedAt !== null
        ? []
        : (bot.channelBindings ?? []).flatMap((binding) => {
            if (binding.provider !== provider || !binding.externalIdentity) return [];

            const discordId = /\(([^()]+)\)$/u.exec(binding.externalIdentity)?.[1];

            return [discordId ?? binding.externalIdentity];
          }),
    ),
  );

const linkOwner = (ctx: ChannelRuntimeContext, identity: ChannelOwnerIdentity) =>
  ctx.withLock("channel-access")(
    Effect.gen(function* () {
      const settings = yield* ctx.deps.settings.getSettings;

      yield* ctx.deps.settings.updateSettings({
        channelOwners: [
          ...settings.channelOwners.filter(
            (owner) =>
              owner.provider !== identity.provider ||
              owner.workspaceId !== identity.workspaceId ||
              owner.userId !== identity.userId,
          ),
          identity,
        ],
      });
    }),
  );

/** Records a message as decided with no turn, so no later delivery of it can start one. */
const markMessageHandled = (
  ctx: ChannelRuntimeContext,
  botId: BotId,
  provider: "slack" | "discord",
  input: ChannelGateInput,
  now: number,
) => {
  const message = {
    botId,
    provider,
    externalThreadId: input.externalThreadId,
    externalMessageId: input.externalMessageId,
  };

  return ctx.follows.atomically(
    Effect.gen(function* () {
      yield* ctx.follows.claimMessage(
        message,
        isoAt(now),
        isoAt(now - CHANNEL_ADMITTED_MESSAGE_RETENTION_MS),
      );
      yield* ctx.follows.finishMessage(message);
    }),
  );
};

const consumeLinkCode = (
  ctx: ChannelRuntimeContext,
  botId: BotId,
  provider: "slack" | "discord",
  input: ChannelGateInput,
  now: number,
  /** Why the sender cannot link, or undefined for a confirmed member of the bot's workspace. */
  refusal: string | undefined,
) =>
  Effect.gen(function* () {
    const code = input.text.trim().toUpperCase();
    const model = yield* ctx.deps.readModel;
    const bot = model.bots.find((candidate) => candidate.id === botId);
    const binding = bot?.channelBindings.find((candidate) => candidate.provider === provider);

    // Check and take the code in one step with nothing to wait on between, so two senders can
    // never both use it. A code belongs to one bot's channel on one provider and connection; any
    // other channel treats it as unknown and leaves it for the channel it was made for. A code
    // works once, even when the sender cannot use it.
    const taken = yield* Effect.sync(() => {
      const pending = ctx.linkCodes.get(code);

      if (pending && pending.expiresAt <= now) ctx.linkCodes.delete(code);

      if (
        !pending ||
        pending.expiresAt <= now ||
        pending.botId !== botId ||
        pending.provider !== provider ||
        !binding ||
        pending.connectionId !== binding.connectionId
      ) {
        return false;
      }

      ctx.linkCodes.delete(code);

      return true;
    });

    if (!taken) return reply(CHANNEL_LINK_INVALID);
    const workspaceId = homeWorkspace(provider, input);

    if (refusal !== undefined || !workspaceId) return reply(refusal ?? CHANNEL_LINK_EXTERNAL);

    // Mark the DM handled before linking: once its sender is an owner, a redelivery after a
    // restart would otherwise read the old code as a request and start a turn.
    yield* markMessageHandled(ctx, botId, provider, input, now);

    yield* linkOwner(ctx, {
      provider,
      workspaceId,
      userId: input.sender.userId,
      ...(input.sender.displayName?.trim() ? { displayName: input.sender.displayName.trim() } : {}),
      linkedAt: isoAt(now),
    });

    return reply(channelLinkedReply(bot?.name ?? "This bot"));
  });

const turn: ChannelGateDecision = { type: "turn" };

/** A bot's access entry for one provider, falling back to an entry saved before access was per provider. */
export const channelBotAccessFor = (
  settings: Pick<ServerSettings, "channelBotAccess">,
  botId: BotId,
  provider: "slack" | "discord",
) =>
  settings.channelBotAccess.find((entry) => entry.botId === botId && entry.provider === provider) ??
  settings.channelBotAccess.find((entry) => entry.botId === botId && entry.provider === undefined);

/**
 * What settings and pending link codes say about a sender: an answer, or that the platform must
 * confirm their workspace first. It reads no other state, so the gate runs it once before the
 * membership lookup, to spare strangers that call, and again inside the lane on fresh state.
 */
const screenSender = (
  settings: ServerSettings,
  linkCodes: ReadonlyMap<string, PendingChannelLinkCode>,
  botId: BotId,
  provider: "slack" | "discord",
  input: ChannelGateInput,
) => {
  const home = homeWorkspace(provider, input);

  const owners = settings.channelOwners.filter(
    (owner) => owner.provider === provider && owner.workspaceId === home,
  );

  const isOwner = owners.some((owner) => owner.userId === input.sender.userId);
  const access = channelBotAccessFor(settings, botId, provider);
  const listed = isOwner || (access?.allowedUserIds.includes(input.sender.userId) ?? false);
  const code = input.text.trim().toUpperCase();
  const pending = linkCodes.get(code);

  // Someone the bot already answers links only with a code waiting for this channel. Their other
  // eight-letter messages ("feedback", "schedule") are requests, not codes.
  const linkAttempt =
    input.kind === "direct" &&
    LINK_CODE_PATTERN.test(code) &&
    (!listed || (pending?.botId === botId && pending.provider === provider));

  const refuse =
    input.kind !== "thread" && access?.replyToOthers
      ? reply(channelOthersReply(owners.find((owner) => owner.displayName)?.displayName))
      : ignore;

  if (!linkAttempt && owners.length === 0) {
    return { answer: input.kind === "thread" ? ignore : reply(CHANNEL_LINK_INSTRUCTIONS) } as const;
  }

  if (!linkAttempt && !listed) return { answer: refuse } as const;

  return { verify: { home, linkAttempt, refuse } } as const;
};

/**
 * The access check for one Slack or Discord message. It reads only settings, pending link codes,
 * the follow store, and the message itself, so a denied message costs no subscription, history
 * read, or turn.
 *
 * The platform membership lookup happens first, outside the channel's access lane, because it
 * waits on the network. Everything that reads or writes access state then runs inside the lane:
 * it confirms the transport is still `attached` and its binding still connected, screens the
 * sender again on fresh settings, and then either takes a link code or claims the message,
 * decides it, and records the outcome in one transaction. `projectId` is the project the channel
 * is assigned to, which scopes its follows. `turnCommandId` is the deterministic command the
 * message starts.
 */
export const evaluateChannelGate = (
  ctx: ChannelRuntimeContext,
  botId: BotId,
  provider: "slack" | "discord",
  projectId: ProjectId,
  input: ChannelGateInput,
  turnCommandId: string,
  attached: () => boolean,
) =>
  Effect.gen(function* () {
    const first = screenSender(
      yield* ctx.deps.settings.getSettings,
      ctx.linkCodes,
      botId,
      provider,
      input,
    );

    if (first.answer) return first.answer;

    // Membership comes from the platform, never the event: Slack fills a missing event team with
    // the receiving workspace, so a Slack Connect guest would otherwise look local.
    const membership = yield* verifiedSenderWorkspace(input);

    const decision = yield* withAccessLane(
      ctx,
      botId,
      provider,
    )(
      Effect.gen(function* () {
        // The channel may have been unassigned, disconnected, or replaced during the lookup.
        if (!attached()) return ignore;
        const model = yield* ctx.deps.readModel;

        const binding = model.bots
          .find((bot) => bot.id === botId && bot.archivedAt === null)
          ?.channelBindings.find((candidate) => candidate.provider === provider);

        if (binding?.status !== "connected") return ignore;

        const screened = screenSender(
          yield* ctx.deps.settings.getSettings,
          ctx.linkCodes,
          botId,
          provider,
          input,
        );

        if (screened.answer) return screened.answer;
        const { home, linkAttempt, refuse } = screened.verify;

        const memberWorkspace =
          home !== undefined && membership.kind === "member" && membership.workspaceId === home
            ? home
            : undefined;

        const nowIso = yield* ctx.deps.nowIso;
        const now = Date.parse(nowIso);

        if (linkAttempt) {
          return yield* consumeLinkCode(
            ctx,
            botId,
            provider,
            input,
            now,
            memberWorkspace !== undefined
              ? undefined
              : membership.kind === "missing-permission"
                ? SLACK_LINK_USERS_READ_MISSING
                : CHANNEL_LINK_EXTERNAL,
          );
        }

        if (memberWorkspace === undefined) return refuse;

        return yield* decideAdmitted(ctx, botId, provider, input, {
          turnCommandId,
          projectId,
          workspaceId: memberWorkspace,
          nowIso,
        });
      }),
    );

    // Still a denial; the binding tells the owner why no one is confirmed. Only a reconnect,
    // which reads the token's scopes afresh, clears it.
    if (membership.kind === "missing-permission") {
      yield* flagMissingPermission(ctx, botId, provider, attached);
    }

    return decision;
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("channel access check failed", { provider, cause }).pipe(Effect.as(ignore)),
    ),
  );

/**
 * Shows on the bot's connected binding that its credentials cannot confirm anyone, unless the
 * binding already shows an error. It runs as a channel operation, like every connect and
 * disconnect, and only while this transport is attached, so it never marks a newer binding.
 */
const flagMissingPermission = (
  ctx: ChannelRuntimeContext,
  botId: BotId,
  provider: "slack" | "discord",
  attached: () => boolean,
) =>
  withChannelOperation(
    ctx,
    provider,
  )(
    Effect.gen(function* () {
      if (!attached()) return;
      const model = yield* ctx.deps.readModel;

      const binding = model.bots
        .find((bot) => bot.id === botId && bot.archivedAt === null)
        ?.channelBindings.find((candidate) => candidate.provider === provider);

      if (binding?.status !== "connected" || binding.lastError) return;
      yield* replaceBinding(ctx, { ...binding, lastError: SLACK_USERS_READ_MISSING });
    }),
  ).pipe(Effect.ignoreCause);

/**
 * Claims an admitted message and decides it, in one transaction. The claim is read inside the
 * transaction, so only one delivery of a message ever decides it; a replay that finds the
 * outcome recorded acts on it and changes no follow. If the outcome write finds the claim
 * already decided, the transaction fails and its follow change rolls back.
 */
const decideAdmitted = (
  ctx: ChannelRuntimeContext,
  botId: BotId,
  provider: "slack" | "discord",
  input: ChannelGateInput,
  decision: FollowScope & { readonly turnCommandId: string },
) =>
  ctx.follows.atomically(
    Effect.gen(function* () {
      const admitted = {
        botId,
        provider,
        externalThreadId: input.externalThreadId,
        externalMessageId: input.externalMessageId,
      };

      // Durable, unlike the SDK's in-memory dedupe: a mention replayed after a restart must not
      // start a follow again, even one that "stop" ended.
      const claim = yield* ctx.follows.claimMessage(
        admitted,
        decision.nowIso,
        isoAt(Date.parse(decision.nowIso) - CHANNEL_ADMITTED_MESSAGE_RETENTION_MS),
      );

      if (claim.status === "done") return ignore;

      // Decided as a turn that was never confirmed accepted. The command ID encodes bot, project,
      // provider, and platform thread, so a match means the channel is still where the turn was
      // decided, and the engine accepts that command at most once. A mismatch means the channel
      // moved, so the turn already belongs elsewhere and nothing runs here.
      if (claim.status === "turn") {
        if (claim.turnCommandId === decision.turnCommandId) return turn;

        yield* Effect.logWarning("channel message replayed after its channel moved", {
          botId,
          provider,
        });
        yield* ctx.follows.finishMessage(admitted);

        return ignore;
      }

      // A new claim, or one a crash left before its outcome was recorded: decide from scratch.
      const outcome =
        input.kind === "direct"
          ? turn
          : yield* followDecision(ctx, botId, provider, input, decision);

      const recorded = yield* ctx.follows.recordOutcome(
        admitted,
        outcome.type === "turn" ? decision.turnCommandId : undefined,
      );

      if (!recorded) return yield* failWith("Channel message was already decided.");

      return outcome;
    }),
  );

/** Where an admitted message's follow lives, and when it was decided. */
interface FollowScope {
  readonly projectId: ProjectId;
  readonly workspaceId: string;
  readonly nowIso: string;
}

/** Starts, renews, or ends the sender's follow of a thread and says whether the message runs. */
const followDecision = (
  ctx: ChannelRuntimeContext,
  botId: BotId,
  provider: "slack" | "discord",
  input: ChannelGateInput,
  { projectId, workspaceId, nowIso }: FollowScope,
) =>
  Effect.gen(function* () {
    const now = Date.parse(nowIso);

    const key: ChannelFollowKey = {
      botId,
      provider,
      projectId,
      workspaceId,
      externalThreadId: input.externalThreadId,
      senderId: input.sender.userId,
    };

    const since = isoAt(now - Duration.toMillis(CHANNEL_FOLLOW_IDLE_LIMIT));
    const follow = yield* ctx.follows.get(key);
    const following = follow !== undefined && follow.lastActivityAt >= since;

    const endFollow = Effect.gen(function* () {
      yield* ctx.follows.end(key);
      const remaining = yield* ctx.follows.listActive(botId, provider, projectId, since);

      // The platform subscription is per thread, so it stays while anyone else is followed there.
      return !remaining.some((entry) => entry.externalThreadId === input.externalThreadId);
    });

    if (follow && !following) yield* ctx.follows.end(key);

    if (STOP_PATTERN.test(input.text.trim())) {
      return following ? reply(CHANNEL_STOP_REPLY, yield* endFollow) : ignore;
    }

    if (input.kind === "thread") {
      if (!following) return ignore;
      const otherBots = otherChannelBotUserIds(yield* ctx.deps.readModel, botId, provider);

      if (input.mentionedUserIds.some((id) => otherBots.has(id))) {
        const unsubscribe = yield* endFollow;

        return { type: "ignore", unsubscribe } satisfies ChannelGateDecision;
      }
    }

    yield* ctx.follows.touch(key, nowIso);

    return turn;
  });

/**
 * Platform threads a bot still follows in the project its channel is assigned to, so the
 * transport can subscribe to them on start. Follows started under another project stay behind.
 */
export const followedExternalThreadIds = (
  ctx: ChannelRuntimeContext,
  botId: BotId,
  provider: ChannelProvider,
  projectId: ProjectId,
) =>
  Effect.gen(function* () {
    const now = Date.parse(yield* ctx.deps.nowIso);
    const since = isoAt(now - Duration.toMillis(CHANNEL_FOLLOW_IDLE_LIMIT));
    const follows = yield* ctx.follows.listActive(botId, provider, projectId, since);

    return [...new Set(follows.map((follow) => follow.externalThreadId))];
  });

const liveChannelBot = (ctx: ChannelRuntimeContext, botId: BotId) =>
  Effect.gen(function* () {
    const model = yield* ctx.deps.readModel;

    const bot = model.bots.find(
      (candidate) => candidate.id === botId && candidate.archivedAt === null,
    );

    if (!bot) return yield* failWith(`Bot '${botId}' is unavailable.`);

    return bot;
  });

/**
 * Registers a link code for a bot's channel. It runs in the channel's access lane and requires a
 * running transport there, so an unassign or disconnect, which detaches the transport and drops
 * the channel's codes in the same lane, never leaves a late code behind.
 */
export const createChannelLinkCode = (
  ctx: ChannelRuntimeContext,
  input: ChannelLinkCodeCreateInput,
) =>
  // The provider's channel operation first, like every connect: a code made while a reconnect
  // is still saving would otherwise be dropped by that reconnect's rollback.
  withChannelOperation(
    ctx,
    input.provider,
  )(
    withAccessLane(
      ctx,
      input.botId,
      input.provider,
    )(
      Effect.gen(function* () {
        const bot = yield* liveChannelBot(ctx, input.botId);

        const binding = (bot.channelBindings ?? []).find(
          (candidate) => candidate.provider === input.provider,
        );

        if (!binding || !ctx.runtimes.has(runtimeKey(input.botId, input.provider))) {
          return yield* failWith("Connect this bot's channel before linking an owner.");
        }

        const now = Date.parse(yield* ctx.deps.nowIso);

        // One code per bot channel: a new code replaces the earlier one.
        for (const [code, pending] of ctx.linkCodes) {
          if (
            pending.expiresAt <= now ||
            (pending.botId === input.botId && pending.provider === input.provider)
          ) {
            ctx.linkCodes.delete(code);
          }
        }

        ctx.linkCodes.set(input.code, {
          botId: input.botId,
          provider: input.provider,
          connectionId: binding.connectionId,
          expiresAt: now + Duration.toMillis(CHANNEL_LINK_CODE_TTL),
        });

        return 0;
      }),
    ),
  );

export const removeChannelOwner = (ctx: ChannelRuntimeContext, input: ChannelOwnerRemoveInput) =>
  ctx.withLock("channel-access")(
    Effect.gen(function* () {
      const settings = yield* ctx.deps.settings.getSettings;

      yield* ctx.deps.settings.updateSettings({
        channelOwners: settings.channelOwners.filter(
          (owner) =>
            owner.provider !== input.provider ||
            owner.workspaceId !== input.workspaceId ||
            owner.userId !== input.userId,
        ),
      });

      return 0;
    }),
  );

export const setChannelAccess = (ctx: ChannelRuntimeContext, input: ChannelAccessSetInput) =>
  ctx.withLock("channel-access")(
    Effect.gen(function* () {
      yield* liveChannelBot(ctx, input.botId);
      const settings = yield* ctx.deps.settings.getSettings;
      const allowedUserIds = [...new Set(input.allowedUserIds)];
      const others = settings.channelBotAccess.filter((entry) => entry.botId !== input.botId);
      const mine = settings.channelBotAccess.filter((entry) => entry.botId === input.botId);
      const legacy = mine.find((entry) => entry.provider === undefined);

      // Keep the other provider's access. A pre-provider entry becomes that provider's own entry.
      const otherProviders = CHANNEL_OWNER_PROVIDERS.filter(
        (provider) => provider !== input.provider,
      ).flatMap((provider) => {
        const entry = mine.find((candidate) => candidate.provider === provider) ?? legacy;

        return entry ? [{ ...entry, provider }] : [];
      });

      yield* ctx.deps.settings.updateSettings({
        channelBotAccess: [
          ...others,
          ...otherProviders,
          ...(allowedUserIds.length > 0 || input.replyToOthers
            ? [
                {
                  botId: input.botId,
                  provider: input.provider,
                  allowedUserIds,
                  replyToOthers: input.replyToOthers,
                },
              ]
            : []),
        ],
      });

      return 0;
    }),
  );
