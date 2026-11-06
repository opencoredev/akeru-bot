import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { ChannelSenderMembership } from "./ChannelRuntimeTypes.ts";

/** How long a confirmed answer about one person's team is reused. */
export const SLACK_MEMBERSHIP_CACHE_TTL_MS = 10 * 60 * 1000;

const SLACK_MEMBERSHIP_CACHE_LIMIT = 1_000;

/** The bot token scope `users.info` needs. Slack apps set up from the earlier guide lack it. */
export const SLACK_USERS_READ_SCOPE = "users:read";

/** Binding warning while the bot token lacks `users:read`, so Akeru can confirm no one. */
export const SLACK_USERS_READ_MISSING =
  "This Slack app is missing the users:read permission, so the bot cannot confirm who messages it and answers no one. Add the users:read bot token scope to the Slack app and reinstall it to the workspace.";

/** The reply to a link code while the bot token lacks `users:read`. */
export const SLACK_LINK_USERS_READ_MISSING =
  "I cannot link you yet: this bot's Slack app is missing the users:read permission, so I cannot confirm you are in this workspace. Add the users:read bot token scope to the Slack app, reinstall it, then create a new link code in Akeru.";

/** The `users.info` fields that say which organization a person belongs to. */
const SlackUserMembership = Schema.Struct({
  ok: Schema.Literal(true),
  user: Schema.Struct({
    team_id: Schema.optional(Schema.String),
    /** Set for people Slack Connect brings in from another organization. */
    is_stranger: Schema.optional(Schema.Boolean),
    /** A deactivated account; messages it queued before deactivation must not run. */
    deleted: Schema.optional(Schema.Boolean),
    /** Multi-channel and single-channel guests. Like Slack Connect people, they never count. */
    is_restricted: Schema.optional(Schema.Boolean),
    is_ultra_restricted: Schema.optional(Schema.Boolean),
    enterprise_user: Schema.optional(
      Schema.Struct({ teams: Schema.optional(Schema.Array(Schema.String)) }),
    ),
  }),
});

const decodeMembership = Schema.decodeUnknownOption(SlackUserMembership);

/**
 * Slack's answer when the token lacks a scope, either as the reply body or, from the Web API
 * client, as the platform error it throws with that body as `data`.
 */
const isMissingScope = Schema.is(
  Schema.Union([
    Schema.Struct({ error: Schema.Literal("missing_scope") }),
    Schema.Struct({
      code: Schema.Literal("slack_webapi_platform_error"),
      data: Schema.Struct({ error: Schema.Literal("missing_scope") }),
    }),
  ]),
);

/** False only when Slack listed the token's scopes and `users:read` is not among them. */
export const slackTokenCanReadUsers = (scopes: ReadonlyArray<string> | undefined) =>
  scopes === undefined || scopes.includes(SLACK_USERS_READ_SCOPE);

interface CachedMembership {
  readonly membership: ChannelSenderMembership;
  readonly expiresAt: number;
}

const unconfirmed: ChannelSenderMembership = { kind: "unconfirmed" };

/**
 * Resolves the Slack team a person belongs to from `users.info`, never from the event: Slack
 * fills a missing event team with the receiving workspace, which would make a Slack Connect
 * guest look local. A person is in the bot's team when Slack lists that team for them and the
 * account is not a stranger, a guest, or deactivated. Anything else, including a failed lookup,
 * is unconfirmed. A token without `users:read` reports `missing-permission`, so the owner learns
 * what to fix. Failed lookups are not cached, so a later message retries.
 */
export function slackMembership<LookupResponse>(input: {
  /** Calls `users.info`; the reply is parsed here, so its own type does not matter. */
  readonly lookup: (userId: string) => Promise<LookupResponse>;
  readonly homeTeamId: () => string | undefined;
  /** A monotonic clock in milliseconds, used only for cache expiry. */
  readonly now: () => number;
}) {
  const now = input.now;
  const cache = new Map<string, CachedMembership>();

  return async (userId: string): Promise<ChannelSenderMembership> => {
    const cached = cache.get(userId);

    if (cached && cached.expiresAt > now()) return cached.membership;
    const home = input.homeTeamId();
    let response: unknown;

    // A thrown error is read like a reply: a scope error says so, and anything else fails to decode.
    try {
      response = await input.lookup(userId);
    } catch (error) {
      response = error;
    }

    if (isMissingScope(response)) return { kind: "missing-permission" };
    const decoded = decodeMembership(response);

    if (Option.isNone(decoded) || home === undefined) return unconfirmed;
    const user = decoded.value.user;

    const fullMember =
      user.is_stranger !== true &&
      user.deleted !== true &&
      user.is_restricted !== true &&
      user.is_ultra_restricted !== true;

    const member =
      fullMember &&
      (user.team_id === home || (user.enterprise_user?.teams?.includes(home) ?? false));

    // Only membership in the bot's team matters, so every other answer is the same denial.
    const membership: ChannelSenderMembership = member
      ? { kind: "member", workspaceId: home }
      : unconfirmed;

    cache.delete(userId);
    cache.set(userId, { membership, expiresAt: now() + SLACK_MEMBERSHIP_CACHE_TTL_MS });

    for (const key of cache.keys()) {
      if (cache.size <= SLACK_MEMBERSHIP_CACHE_LIMIT) break;
      cache.delete(key);
    }

    return membership;
  };
}
