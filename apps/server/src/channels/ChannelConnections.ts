import * as Predicate from "effect/Predicate";
import {
  BotId,
  ChannelConnectionId,
  CommandId,
  type ProjectId,
  type ChannelConnectionProfile,
  type ChannelProvider,
} from "@akeru/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { failWith, channelFailureMessage, channelFailurePresentation } from "./ChannelErrors.ts";
import {
  type ChannelOperationError,
  type LiveProvider,
  type ChannelConnectInput,
  type ChannelConnectionSaveInput,
  type ChannelRestoreFailure,
  type ChannelRuntimeContext,
} from "./ChannelRuntimeTypes.ts";
import {
  encodeStoredChannelSecret,
  runtimeKey,
  secretName,
  connectionSecretName,
  randomId,
  loadSecret,
  loadConnectionSecret,
  storedSecretFromInput,
  connectInputFromSecret,
  assertChannelIdentityAvailable,
} from "./ChannelSecrets.ts";
import { whatsAppWebhookUrl } from "./ChannelWebhooks.ts";
import {
  replaceBinding,
  withChannelOperation,
  withConnectionOperation,
  withConnectionSettingsOperation,
  stopRuntime,
} from "./ChannelOperations.ts";
import { startAndCommitChannel } from "./ChannelConnectionLifecycle.ts";
import { setChannelDelivery } from "./ChannelDelivery.ts";

export const connectChannel = (ctx: ChannelRuntimeContext, input: ChannelConnectInput) =>
  withChannelOperation(
    ctx,
    input.provider,
  )(
    Effect.gen(function* () {
      yield* assertChannelIdentityAvailable(ctx, input.botId, storedSecretFromInput(input));

      return yield* startAndCommitChannel(ctx, input, { secret: storedSecretFromInput(input) });
    }),
  );

export const optionalWebhookUrl = (
  publicOrigin: string | undefined,
  connectionId: ChannelConnectionId,
) => {
  const webhookUrl = whatsAppWebhookUrl(publicOrigin, connectionId);

  return webhookUrl ? { webhookUrl } : {};
};

export /** Rewrites saved WhatsApp webhook URLs when the server's public origin changed since they were saved. */
const syncWhatsAppWebhookUrls = (ctx: ChannelRuntimeContext) =>
  withConnectionSettingsOperation(ctx)(
    Effect.gen(function* () {
      const settings = yield* ctx.deps.settings.getSettings;
      let changed = false;

      const channelConnections = settings.channelConnections.map((connection) => {
        if (connection.provider !== "whatsapp") return connection;
        const webhookUrl = whatsAppWebhookUrl(ctx.deps.publicOrigin, connection.id);

        if (connection.webhookUrl === webhookUrl) return connection;
        changed = true;
        const { webhookUrl: _stale, ...rest } = connection;

        return webhookUrl ? { ...rest, webhookUrl } : rest;
      });

      if (changed) yield* ctx.deps.settings.updateSettings({ channelConnections });
    }),
  );

export const saveChannelConnection = (
  ctx: ChannelRuntimeContext,
  input: ChannelConnectionSaveInput,
) =>
  withConnectionSettingsOperation(ctx)(
    withConnectionOperation(
      ctx,
      input.connectionId,
    )(
      Effect.gen(function* () {
        const deps = ctx.deps;
        const model = yield* deps.readModel;

        const attached = model.bots.some((bot) =>
          (bot.channelBindings ?? []).some(
            (binding) => binding.connectionId === input.connectionId,
          ),
        );

        if (attached) return yield* failWith("Unassign this channel before editing it.");
        const secretKey = connectionSecretName(input.connectionId);
        const previousSecret = yield* deps.secretStore.get(secretKey);
        const settings = yield* deps.settings.getSettings;

        const profile: ChannelConnectionProfile = {
          id: input.connectionId,
          name: input.name,
          provider: input.provider,
          adapter: input.provider === "imessage" ? "photon" : input.provider,
          ...(input.provider === "whatsapp"
            ? {
                externalIdentity: input.phoneNumberId,
                ...optionalWebhookUrl(deps.publicOrigin, input.connectionId),
              }
            : input.provider === "imessage"
              ? {
                  externalIdentity:
                    input.mode === "hosted" ? input.projectId : (input.phone ?? input.serverUrl),
                  ...(input.mode === "hosted"
                    ? {
                        managementUrl: `https://app.photon.codes/dashboard/${encodeURIComponent(input.projectId)}`,
                      }
                    : {}),
                }
              : input.provider === "slack"
                ? { managementUrl: "https://api.slack.com/apps" }
                : input.provider === "discord"
                  ? {
                      externalIdentity: input.applicationId,
                      managementUrl: `https://discord.com/developers/applications/${encodeURIComponent(input.applicationId)}`,
                    }
                  : {}),
        };

        yield* deps.secretStore.set(
          secretKey,
          yield* encodeStoredChannelSecret(storedSecretFromInput(input)),
        );
        yield* deps.settings
          .updateSettings({
            channelConnections: [
              ...settings.channelConnections.filter(
                (connection) => connection.id !== input.connectionId,
              ),
              profile,
            ],
          })
          .pipe(
            Effect.onError(() =>
              (Predicate.isTagged(previousSecret, "Some")
                ? deps.secretStore.set(secretKey, previousSecret.value)
                : deps.secretStore.remove(secretKey)
              ).pipe(Effect.ignoreCause),
            ),
          );

        return 0;
      }),
    ),
  );

export const deleteChannelConnection = (
  ctx: ChannelRuntimeContext,
  connectionId: ChannelConnectionId,
) =>
  withConnectionSettingsOperation(ctx)(
    withConnectionOperation(
      ctx,
      connectionId,
    )(
      Effect.gen(function* () {
        const deps = ctx.deps;
        const model = yield* deps.readModel;

        if (
          model.bots.some((bot) =>
            (bot.channelBindings ?? []).some((binding) => binding.connectionId === connectionId),
          )
        ) {
          return yield* failWith("Unassign this channel before deleting it.");
        }

        const secretKey = connectionSecretName(connectionId);
        const previousSecret = yield* deps.secretStore.get(secretKey);
        const settings = yield* deps.settings.getSettings;
        yield* deps.secretStore.remove(secretKey);
        yield* deps.settings
          .updateSettings({
            channelConnections: settings.channelConnections.filter(
              (connection) => connection.id !== connectionId,
            ),
          })
          .pipe(
            Effect.onError(() =>
              Predicate.isTagged(previousSecret, "Some")
                ? deps.secretStore.set(secretKey, previousSecret.value).pipe(Effect.ignoreCause)
                : Effect.void,
            ),
          );

        return 0;
      }),
    ),
  );

export const attachChannelConnection = (
  ctx: ChannelRuntimeContext,
  botId: BotId,
  connectionId: ChannelConnectionId,
  projectId: ProjectId,
  provider: ChannelProvider,
) =>
  withConnectionOperation(
    ctx,
    connectionId,
  )(
    withChannelOperation(
      ctx,
      provider,
    )(
      Effect.gen(function* () {
        const model = yield* ctx.deps.readModel;

        const bot = model.bots.find(
          (candidate) => candidate.id === botId && candidate.archivedAt === null,
        );

        if (!bot) return yield* failWith(`Bot '${botId}' is unavailable.`);

        const project = model.projects.find(
          (candidate) => candidate.id === projectId && candidate.deletedAt === null,
        );

        if (!project)
          return yield* failWith(
            "The selected project is unavailable. Choose another project.",
            "project",
          );

        const inUse = model.bots.some(
          (bot) =>
            bot.id !== botId &&
            bot.archivedAt === null &&
            (bot.channelBindings ?? []).some((binding) => binding.connectionId === connectionId),
        );

        if (inUse) return yield* failWith("This channel connection is attached to another bot.");
        const secret = yield* loadConnectionSecret(ctx, connectionId);

        if (!secret || secret.provider !== provider)
          return yield* failWith("Saved channel connection is unavailable.");
        yield* assertChannelIdentityAvailable(ctx, botId, secret);
        const commandId = CommandId.make(yield* randomId(ctx, "channel-attach"));
        const input = yield* connectInputFromSecret(botId, projectId, commandId, secret);

        return yield* startAndCommitChannel(ctx, input, { connectionId });
      }),
    ),
  );

export const currentBindingFor = (
  ctx: ChannelRuntimeContext,
  botId: BotId,
  provider: ChannelProvider,
) =>
  Effect.gen(function* () {
    const model = yield* ctx.deps.readModel;

    const binding = model.bots
      .find((bot) => bot.id === botId)
      ?.channelBindings?.find((candidate) => candidate.provider === provider);

    if (!binding) return yield* failWith(`No ${provider} channel is assigned to this bot.`);

    return binding;
  });

export const disconnectChannel = (
  ctx: ChannelRuntimeContext,
  botId: BotId,
  provider: ChannelProvider,
) =>
  withChannelOperation(
    ctx,
    provider,
  )(
    Effect.gen(function* () {
      const currentBinding = yield* currentBindingFor(ctx, botId, provider);

      const sequence = yield* replaceBinding(ctx, {
        ...currentBinding,
        status: "disconnected",
        connectedAt: null,
        lastAttemptAt: yield* ctx.deps.nowIso,
      });

      yield* stopRuntime(ctx, botId, provider);

      return sequence;
    }),
  );

export const detachChannelConnection = (
  ctx: ChannelRuntimeContext,
  botId: BotId,
  provider: ChannelProvider,
) =>
  withChannelOperation(
    ctx,
    provider,
  )(
    Effect.gen(function* () {
      const deps = ctx.deps;
      const currentBinding = yield* currentBindingFor(ctx, botId, provider);
      const name = secretName(botId, provider);

      const previousSecret = currentBinding.connectionId
        ? undefined
        : yield* deps.secretStore.get(name);

      if (!currentBinding.connectionId) {
        yield* deps.secretStore.remove(name);
      }

      const sequence = yield* replaceBinding(ctx, {
        botId,
        provider,
        status: "disconnected",
        externalIdentity: null,
        connectedAt: null,
        sentMessageIds: [],
      }).pipe(
        Effect.onError(() =>
          previousSecret?._tag === "Some"
            ? deps.secretStore.set(name, previousSecret.value).pipe(Effect.ignoreCause)
            : Effect.void,
        ),
      );

      yield* stopRuntime(ctx, botId, provider);

      return sequence;
    }),
  );

export /**
 * Moves a bot's channel to another live project. The old runtime stops before the new one
 * starts because most transports cannot poll with the same credentials twice. If the new
 * runtime cannot start, the binding keeps its previous project and records the failure, and
 * a previously connected channel is restarted on its old project when possible. If the old
 * runtime fails to stop, the move fails and that runtime stays registered.
 */
const changeChannelProject = (
  ctx: ChannelRuntimeContext,
  botId: BotId,
  provider: LiveProvider,
  projectId: ProjectId,
) =>
  withChannelOperation(
    ctx,
    provider,
  )(
    Effect.gen(function* () {
      const model = yield* ctx.deps.readModel;

      const bot = model.bots.find(
        (candidate) => candidate.id === botId && candidate.archivedAt === null,
      );

      if (!bot) return yield* failWith(`Bot '${botId}' is unavailable.`);

      const project = model.projects.find(
        (candidate) => candidate.id === projectId && candidate.deletedAt === null,
      );

      if (!project)
        return yield* failWith(
          "The selected project is unavailable. Choose another project.",
          "project",
        );
      const binding = bot.channelBindings?.find((candidate) => candidate.provider === provider);

      if (!binding) return yield* failWith(`No ${provider} channel is assigned to this bot.`);

      // A running channel already in the target project has nowhere to move.
      if (
        binding.status === "connected" &&
        binding.projectId === projectId &&
        ctx.runtimes.has(runtimeKey(botId, provider))
      ) {
        return model.snapshotSequence;
      }

      // The user turned this channel off. Moving it keeps it off until they reconnect.
      if (binding.status === "disconnected") {
        return yield* replaceBinding(ctx, { ...binding, projectId });
      }

      const secret = binding.connectionId
        ? yield* loadConnectionSecret(ctx, binding.connectionId)
        : yield* loadSecret(ctx, botId, provider);

      if (!secret || secret.provider !== provider)
        return yield* failWith(`No saved ${provider} credentials.`);
      yield* assertChannelIdentityAvailable(ctx, botId, secret);
      // A transport that fails to stop stays registered, and no competing one starts.
      yield* stopRuntime(ctx, botId, provider, { keepOnFailure: true });

      const startOn = (target: ProjectId) =>
        Effect.gen(function* () {
          const commandId = CommandId.make(yield* randomId(ctx, "channel-change-project"));
          const input = yield* connectInputFromSecret(botId, target, commandId, secret);

          return yield* startAndCommitChannel(ctx, input, {
            connectionId: binding.connectionId,
            recordFailure: false,
          });
        });

      return yield* startOn(projectId).pipe(
        Effect.catch((cause) => {
          const restore =
            binding.status === "connected" && binding.projectId && binding.projectId !== projectId
              ? startOn(binding.projectId).pipe(
                  Effect.as(true),
                  Effect.catch(() => Effect.succeed(false)),
                )
              : Effect.succeed(false);

          return restore.pipe(
            Effect.flatMap((restored) =>
              restored
                ? Effect.fail(cause)
                : Effect.gen(function* () {
                    const category = channelFailurePresentation(cause).category;
                    yield* replaceBinding(ctx, {
                      ...binding,
                      status: binding.status === "blocked" ? "blocked" : "failed",
                      connectedAt: null,
                      lastAttemptAt: yield* ctx.deps.nowIso,
                      lastError: "Could not start the channel in the selected project. Try again.",
                      ...(category ? { failureCategory: category } : {}),
                    }).pipe(Effect.ignoreCause);

                    return yield* Effect.fail(cause);
                  }),
            ),
          );
        }),
      );
    }),
  );

export const reconnectChannel = (
  ctx: ChannelRuntimeContext,
  botId: BotId,
  provider: LiveProvider,
) =>
  withChannelOperation(
    ctx,
    provider,
  )(
    Effect.gen(function* () {
      const binding = yield* currentBindingFor(ctx, botId, provider);

      const secret = binding.connectionId
        ? yield* loadConnectionSecret(ctx, binding.connectionId)
        : yield* loadSecret(ctx, botId, provider);

      if (!secret || secret.provider !== provider)
        return yield* failWith(`No saved ${provider} credentials.`);

      if (!binding.projectId)
        return yield* failWith("Select a project before reconnecting this channel.", "project");
      yield* assertChannelIdentityAvailable(ctx, botId, secret);
      const commandId = CommandId.make(yield* randomId(ctx, "channel-reconnect"));
      const input = yield* connectInputFromSecret(botId, binding.projectId, commandId, secret);

      return yield* startAndCommitChannel(ctx, input, { connectionId: binding.connectionId });
    }),
  );

export const restoreConnectedChannels = (
  ctx: ChannelRuntimeContext,
): Effect.Effect<ReadonlyArray<ChannelRestoreFailure>, ChannelOperationError> =>
  Effect.gen(function* () {
    const deps = ctx.deps;
    yield* syncWhatsAppWebhookUrls(ctx).pipe(
      Effect.catchCause(() => Effect.logWarning("Could not refresh WhatsApp webhook URLs.")),
    );
    const model = yield* deps.readModel;

    const candidates = model.bots.flatMap((bot) =>
      bot.archivedAt === null
        ? (bot.channelBindings ?? []).flatMap((binding) =>
            binding.status === "connected" ||
            binding.status === "needs-reconnect" ||
            binding.status === "connecting" ||
            binding.status === "not-live"
              ? [{ botId: bot.id, provider: binding.provider }]
              : [],
          )
        : [],
    );

    // Deliveries still "requested" after a restart are ambiguous: the send
    // that created them was interrupted, so the post may or may not have
    // landed. Reconcile the projected "pending" state to "unknown" so clients
    // stop showing "Sending…" forever and admins can retry the reply.
    // A reply whose post landed but whose durable mark failed is recorded in the
    // binding, so it is sent rather than ambiguous. Reconciliation is best effort
    // and never keeps a channel from reconnecting.
    yield* Effect.gen(function* () {
      const staleClaims = yield* deps.deliveryStore.listRequestedClaims();

      for (const claim of staleClaims) {
        const thread = yield* deps.readThread(claim.threadId);

        const delivery = thread?.messages.find(
          (message) => message.id === claim.messageId,
        )?.channelDelivery;

        if (delivery !== "pending" && delivery !== undefined) continue;

        const sent = model.bots
          .find((bot) => bot.id === claim.botId)
          ?.channelBindings?.find((binding) => binding.provider === claim.provider)
          ?.sentMessageIds.includes(claim.messageId);

        yield* setChannelDelivery(ctx, claim.threadId, claim.messageId, sent ? "sent" : "unknown");
      }
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not reconcile interrupted channel deliveries.", cause),
      ),
    );

    const results = yield* Effect.forEach(
      candidates,
      (candidate) =>
        reconnectChannel(ctx, candidate.botId, candidate.provider).pipe(
          Effect.catchCause(() =>
            Effect.gen(function* () {
              const latest = yield* deps.readModel;

              const binding = latest.bots
                .find((bot) => bot.id === candidate.botId)
                ?.channelBindings?.find((entry) => entry.provider === candidate.provider);

              if (binding) {
                // A deleted project needs a new project, not new credentials.
                const projectMissing = !latest.projects.some(
                  (project) => project.id === binding.projectId && project.deletedAt === null,
                );

                yield* Effect.gen(function* () {
                  yield* replaceBinding(ctx, {
                    ...binding,
                    status: projectMissing ? "blocked" : "failed",
                    connectedAt: null,
                    lastAttemptAt: yield* deps.nowIso,
                    lastError: projectMissing
                      ? "The selected project is unavailable. Choose another project."
                      : channelFailureMessage("restore"),
                    failureCategory: "restore",
                  });
                }).pipe(Effect.ignoreCause);
              }

              return yield* failWith("Channel restore failed.");
            }),
          ),
          Effect.exit,
        ),
      { concurrency: "unbounded" },
    );

    return results.flatMap((exit, index) =>
      Exit.isFailure(exit) ? [{ ...candidates[index]!, category: "restore" as const }] : [],
    );
  });
