import { BotId, ChannelProvider, IsoDateTime, ProjectId } from "@akeru/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { toPersistenceSqlError, type ProjectionRepositoryError } from "../persistence/Errors.ts";

/**
 * Which bot follows which platform thread for which linked person. A follow belongs to the project
 * the channel was assigned to when it started, so moving the channel leaves it behind.
 */
export const ChannelFollowKey = Schema.Struct({
  botId: BotId,
  provider: ChannelProvider,
  projectId: ProjectId,
  /** Slack team ID, or the shared Discord workspace ID. */
  workspaceId: Schema.String,
  /** Encodes the platform channel and thread, such as `slack:C123:1710000000.000100`. */
  externalThreadId: Schema.String,
  senderId: Schema.String,
});

export type ChannelFollowKey = typeof ChannelFollowKey.Type;

export const ChannelFollow = Schema.Struct({
  ...ChannelFollowKey.fields,
  startedAt: IsoDateTime,
  lastActivityAt: IsoDateTime,
});

export type ChannelFollow = typeof ChannelFollow.Type;

/** One platform message a bot admitted, so a replay of it never runs the access check again. */
export const ChannelAdmittedMessage = Schema.Struct({
  botId: BotId,
  provider: ChannelProvider,
  externalThreadId: Schema.String,
  externalMessageId: Schema.String,
});

export type ChannelAdmittedMessage = typeof ChannelAdmittedMessage.Type;

/** Platforms redeliver within minutes to hours; a week of claims covers restarts and backlogs. */
export const CHANNEL_ADMITTED_MESSAGE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export interface ChannelFollowStoreShape {
  readonly get: (
    key: ChannelFollowKey,
  ) => Effect.Effect<ChannelFollow | undefined, ProjectionRepositoryError>;
  /** Starts a follow, or records new activity on an existing one. */
  readonly touch: (
    key: ChannelFollowKey,
    at: string,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly end: (key: ChannelFollowKey) => Effect.Effect<void, ProjectionRepositoryError>;
  /** Follows of one bot's channel in one project with activity at or after `since`. */
  readonly listActive: (
    botId: BotId,
    provider: ChannelProvider,
    projectId: ProjectId,
    since: string,
  ) => Effect.Effect<ReadonlyArray<ChannelFollow>, ProjectionRepositoryError>;
  /**
   * Claims a message a bot admitted and returns the claim's state. A new claim, and one a crash
   * left before its outcome was recorded, is `evaluating`: the caller decides from scratch. Claims
   * older than `expiredBefore` are dropped on the way.
   */
  readonly claimMessage: (
    message: ChannelAdmittedMessage,
    at: string,
    expiredBefore: string,
  ) => Effect.Effect<ChannelMessageClaim, ProjectionRepositoryError>;
  /**
   * Records the decision: the turn command the message starts, or `undefined` for no turn. False
   * when the claim was no longer `evaluating`, so the caller must abandon its follow change.
   */
  readonly recordOutcome: (
    message: ChannelAdmittedMessage,
    turnCommandId: string | undefined,
  ) => Effect.Effect<boolean, ProjectionRepositoryError>;
  /** Marks a claim done once its turn command is accepted. */
  readonly finishMessage: (
    message: ChannelAdmittedMessage,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  /** Runs follow changes and the outcome they lead to as one write, one at a time. */
  readonly atomically: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | ProjectionRepositoryError, R>;
}

/** Where an admitted message stands. A `turn` names the command its replay may run again. */
export type ChannelMessageClaim =
  | { readonly status: "evaluating" }
  | { readonly status: "turn"; readonly turnCommandId: string }
  | { readonly status: "done" };

export class ChannelFollowStore extends Context.Service<
  ChannelFollowStore,
  ChannelFollowStoreShape
>()("akeru-bot/channels/ChannelFollowStore") {}

const decodeFollows = Schema.decodeUnknownSync(Schema.Array(ChannelFollow));

export const makeChannelFollowStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const get: ChannelFollowStoreShape["get"] = (key) =>
    sql`
      SELECT
        bot_id AS "botId",
        provider,
        project_id AS "projectId",
        workspace_id AS "workspaceId",
        external_thread_id AS "externalThreadId",
        sender_id AS "senderId",
        started_at AS "startedAt",
        last_activity_at AS "lastActivityAt"
      FROM channel_thread_follows
      WHERE bot_id = ${key.botId} AND provider = ${key.provider} AND project_id = ${key.projectId}
        AND workspace_id = ${key.workspaceId} AND external_thread_id = ${key.externalThreadId}
        AND sender_id = ${key.senderId}
    `.pipe(
      Effect.map((rows) => decodeFollows(rows)[0]),
      Effect.mapError(toPersistenceSqlError("ChannelFollowStore.get")),
    );

  const touch: ChannelFollowStoreShape["touch"] = (key, at) =>
    sql`
      INSERT INTO channel_thread_follows (
        bot_id, provider, project_id, workspace_id, external_thread_id, sender_id, started_at,
        last_activity_at
      ) VALUES (
        ${key.botId}, ${key.provider}, ${key.projectId}, ${key.workspaceId}, ${key.externalThreadId},
        ${key.senderId}, ${at}, ${at}
      )
      ON CONFLICT (bot_id, provider, project_id, workspace_id, external_thread_id, sender_id)
      DO UPDATE SET last_activity_at = excluded.last_activity_at
    `.pipe(Effect.asVoid, Effect.mapError(toPersistenceSqlError("ChannelFollowStore.touch")));

  const end: ChannelFollowStoreShape["end"] = (key) =>
    sql`
      DELETE FROM channel_thread_follows
      WHERE bot_id = ${key.botId} AND provider = ${key.provider} AND project_id = ${key.projectId}
        AND workspace_id = ${key.workspaceId} AND external_thread_id = ${key.externalThreadId}
        AND sender_id = ${key.senderId}
    `.pipe(Effect.asVoid, Effect.mapError(toPersistenceSqlError("ChannelFollowStore.end")));

  const listActive: ChannelFollowStoreShape["listActive"] = (botId, provider, projectId, since) =>
    sql`
      SELECT
        bot_id AS "botId",
        provider,
        project_id AS "projectId",
        workspace_id AS "workspaceId",
        external_thread_id AS "externalThreadId",
        sender_id AS "senderId",
        started_at AS "startedAt",
        last_activity_at AS "lastActivityAt"
      FROM channel_thread_follows
      WHERE bot_id = ${botId} AND provider = ${provider} AND project_id = ${projectId}
        AND last_activity_at >= ${since}
    `.pipe(
      Effect.map((rows) => decodeFollows(rows)),
      Effect.mapError(toPersistenceSqlError("ChannelFollowStore.listActive")),
    );

  const claimMessage: ChannelFollowStoreShape["claimMessage"] = (message, at, expiredBefore) =>
    Effect.gen(function* () {
      yield* sql`DELETE FROM channel_admitted_messages WHERE admitted_at < ${expiredBefore}`;
      yield* sql`
        INSERT OR IGNORE INTO channel_admitted_messages (
          bot_id, provider, external_thread_id, external_message_id, admitted_at, status
        ) VALUES (
          ${message.botId}, ${message.provider}, ${message.externalThreadId},
          ${message.externalMessageId}, ${at}, 'evaluating'
        )
      `;

      const rows = yield* sql<{
        readonly status: string;
        readonly turnCommandId: string | null;
      }>`
        SELECT status, turn_command_id AS "turnCommandId" FROM channel_admitted_messages
        WHERE bot_id = ${message.botId} AND provider = ${message.provider}
          AND external_thread_id = ${message.externalThreadId}
          AND external_message_id = ${message.externalMessageId}
      `;

      const row = rows[0];

      if (row?.status === "turn" && row.turnCommandId) {
        return { status: "turn", turnCommandId: row.turnCommandId } as const;
      }

      return row?.status === "evaluating"
        ? ({ status: "evaluating" } as const)
        : ({ status: "done" } as const);
    }).pipe(Effect.mapError(toPersistenceSqlError("ChannelFollowStore.claimMessage")));

  const recordOutcome: ChannelFollowStoreShape["recordOutcome"] = (message, turnCommandId) =>
    sql<{ readonly botId: string }>`
      UPDATE channel_admitted_messages
      SET status = ${turnCommandId ? "turn" : "done"}, turn_command_id = ${turnCommandId ?? null}
      WHERE bot_id = ${message.botId} AND provider = ${message.provider}
        AND external_thread_id = ${message.externalThreadId}
        AND external_message_id = ${message.externalMessageId}
        AND status = 'evaluating'
      RETURNING bot_id AS "botId"
    `.pipe(
      Effect.map((rows) => rows.length === 1),
      Effect.mapError(toPersistenceSqlError("ChannelFollowStore.recordOutcome")),
    );

  const finishMessage: ChannelFollowStoreShape["finishMessage"] = (message) =>
    sql`
      UPDATE channel_admitted_messages SET status = 'done'
      WHERE bot_id = ${message.botId} AND provider = ${message.provider}
        AND external_thread_id = ${message.externalThreadId}
        AND external_message_id = ${message.externalMessageId}
    `.pipe(
      Effect.asVoid,
      Effect.mapError(toPersistenceSqlError("ChannelFollowStore.finishMessage")),
    );

  // SQLite allows one transaction per connection, so outcome writes take turns.
  const writeLock = yield* Semaphore.make(1);

  const atomically: ChannelFollowStoreShape["atomically"] = (effect) =>
    writeLock.withPermit(
      sql
        .withTransaction(effect)
        .pipe(
          Effect.catchTag("SqlError", (error) =>
            Effect.fail(toPersistenceSqlError("ChannelFollowStore.atomically")(error)),
          ),
        ),
    );

  return {
    get,
    touch,
    end,
    listActive,
    claimMessage,
    recordOutcome,
    finishMessage,
    atomically,
  } satisfies ChannelFollowStoreShape;
});

export const ChannelFollowStoreLive = Layer.effect(ChannelFollowStore, makeChannelFollowStore);

const followKeyString = (key: ChannelFollowKey) =>
  [
    key.botId,
    key.provider,
    key.projectId,
    key.workspaceId,
    key.externalThreadId,
    key.senderId,
  ].join("\0");

export function memoryChannelFollowStore(): ChannelFollowStoreShape {
  const follows = new Map<string, ChannelFollow>();
  const admitted = new Map<string, { readonly at: string; claim: ChannelMessageClaim }>();

  const admittedId = (message: ChannelAdmittedMessage) =>
    [message.botId, message.provider, message.externalThreadId, message.externalMessageId].join(
      "\0",
    );

  return {
    get: (key) => Effect.sync(() => follows.get(followKeyString(key))),
    touch: (key, at) =>
      Effect.sync(() => {
        const id = followKeyString(key);
        const existing = follows.get(id);

        follows.set(id, {
          ...key,
          startedAt: existing?.startedAt ?? at,
          lastActivityAt: at,
        });
      }),
    end: (key) =>
      Effect.sync(() => {
        follows.delete(followKeyString(key));
      }),
    claimMessage: (message, at, expiredBefore) =>
      Effect.sync(() => {
        for (const [id, entry] of admitted) {
          if (entry.at < expiredBefore) admitted.delete(id);
        }

        const existing = admitted.get(admittedId(message));

        if (existing) return existing.claim;
        admitted.set(admittedId(message), { at, claim: { status: "evaluating" } });

        return { status: "evaluating" } as const;
      }),
    recordOutcome: (message, turnCommandId) =>
      Effect.sync(() => {
        const existing = admitted.get(admittedId(message));

        if (existing?.claim.status !== "evaluating") return false;

        existing.claim = turnCommandId ? { status: "turn", turnCommandId } : { status: "done" };

        return true;
      }),
    finishMessage: (message) =>
      Effect.sync(() => {
        const existing = admitted.get(admittedId(message));

        if (existing) existing.claim = { status: "done" };
      }),
    // Like the SQL transaction: a failure puts follows and claims back as they were.
    atomically: (effect) =>
      Effect.suspend(() => {
        const savedFollows = new Map(follows);

        const savedAdmitted = new Map(
          [...admitted].map(([id, entry]) => [id, { ...entry }] as const),
        );

        return effect.pipe(
          Effect.onError(() =>
            Effect.sync(() => {
              follows.clear();
              admitted.clear();

              for (const [id, follow] of savedFollows) follows.set(id, follow);

              for (const [id, entry] of savedAdmitted) admitted.set(id, entry);
            }),
          ),
        );
      }),
    listActive: (botId, provider, projectId, since) =>
      Effect.sync(() =>
        [...follows.values()].filter(
          (follow) =>
            follow.botId === botId &&
            follow.provider === provider &&
            follow.projectId === projectId &&
            follow.lastActivityAt >= since,
        ),
      ),
  };
}
