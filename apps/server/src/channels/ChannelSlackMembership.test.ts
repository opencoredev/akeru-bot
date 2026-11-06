import { describe, expect, it } from "vite-plus/test";

import {
  SLACK_MEMBERSHIP_CACHE_TTL_MS,
  slackMembership,
  slackTokenCanReadUsers,
} from "./ChannelSlackMembership.ts";

const member = { kind: "member", workspaceId: "T-HOME" };

const unconfirmed = { kind: "unconfirmed" };

const missingPermission = { kind: "missing-permission" };

const user = (fields: Record<string, string | boolean | { teams: string[] }>) => ({
  ok: true,
  user: fields,
});

describe("slackMembership", () => {
  type Answer =
    | ReturnType<typeof user>
    | { readonly ok: false; readonly error: string }
    | Error
    | { readonly thrown: unknown };

  const resolve = (answers: Record<string, Answer>, clock = { now: 0 }) => {
    const lookups: string[] = [];

    const verified = slackMembership({
      lookup: async (userId) => {
        lookups.push(userId);
        const answer = answers[userId];

        if (answer instanceof Error) throw answer;

        if (answer && "thrown" in answer) throw answer.thrown;

        return answer;
      },
      homeTeamId: () => "T-HOME",
      now: () => clock.now,
    });

    return { verified, lookups };
  };

  it("confirms a member of the bot's team", async () => {
    const { verified } = resolve({ U1: user({ team_id: "T-HOME" }) });

    expect(await verified("U1")).toEqual(member);
  });

  it("never confirms a Slack Connect stranger, even one Slack lists under the bot's team", async () => {
    const { verified } = resolve({
      U1: user({ team_id: "T-PARTNER", is_stranger: true }),
      U2: user({ team_id: "T-HOME", is_stranger: true }),
    });

    expect(await verified("U1")).toEqual(unconfirmed);
    expect(await verified("U2")).toEqual(unconfirmed);
  });

  it("never confirms a deactivated account or a guest of the bot's team", async () => {
    const { verified } = resolve({
      U1: user({ team_id: "T-HOME", deleted: true }),
      U2: user({ team_id: "T-HOME", is_restricted: true }),
      U3: user({ team_id: "T-HOME", is_ultra_restricted: true }),
      U4: user({ team_id: "T-PARTNER", deleted: true }),
    });

    for (const userId of ["U1", "U2", "U3", "U4"])
      expect(await verified(userId)).toEqual(unconfirmed);
  });

  it("confirms an Enterprise Grid member whose org includes the bot's team", async () => {
    const { verified } = resolve({
      U1: user({ team_id: "T-OTHER", enterprise_user: { teams: ["T-OTHER", "T-HOME"] } }),
    });

    expect(await verified("U1")).toEqual(member);
  });

  it("denies when the lookup fails or returns no team, and retries next time", async () => {
    const { verified, lookups } = resolve({
      U1: new Error("network"),
      U2: { ok: false, error: "user_not_found" },
      U3: user({}),
    });

    expect(await verified("U1")).toEqual(unconfirmed);
    expect(await verified("U1")).toEqual(unconfirmed);
    expect(await verified("U2")).toEqual(unconfirmed);
    expect(await verified("U3")).toEqual(unconfirmed);
    expect(lookups.filter((id) => id === "U1")).toHaveLength(2);
  });

  it("reports a token without users:read instead of an unknown workspace, and retries", async () => {
    // The Web API client throws Slack's `ok: false` reply as a platform error carrying the body.
    const platformError = Object.assign(new Error("An API error occurred: missing_scope"), {
      code: "slack_webapi_platform_error",
      data: { ok: false, error: "missing_scope", needed: "users:read" },
    });

    const { verified, lookups } = resolve({
      U1: { thrown: platformError },
      U2: { ok: false, error: "missing_scope" },
    });

    expect(await verified("U1")).toEqual(missingPermission);
    expect(await verified("U1")).toEqual(missingPermission);
    expect(await verified("U2")).toEqual(missingPermission);
    expect(lookups.filter((id) => id === "U1")).toHaveLength(2);
  });

  it("flags a token only when Slack lists its scopes without users:read", () => {
    expect(slackTokenCanReadUsers(["chat:write", "users:read"])).toBe(true);
    expect(slackTokenCanReadUsers(["chat:write", "im:history"])).toBe(false);
    expect(slackTokenCanReadUsers(undefined)).toBe(true);
  });

  it("reuses an answer until it expires", async () => {
    const clock = { now: 0 };
    const { verified, lookups } = resolve({ U1: user({ team_id: "T-HOME" }) }, clock);

    await verified("U1");
    await verified("U1");
    clock.now = SLACK_MEMBERSHIP_CACHE_TTL_MS + 1;
    await verified("U1");

    expect(lookups).toEqual(["U1", "U1"]);
  });
});
