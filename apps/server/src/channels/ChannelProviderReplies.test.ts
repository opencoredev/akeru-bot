import {
  failureOf,
  expectFailureMessage,
  connectChannel,
  sendChannelMessage,
  BOT_ID,
  makeAdapterDeliveryHarness,
  mockTelegramDelivery,
  telegramConnect,
  whatsappConnect,
  slackConnect,
  discordConnect,
  externalAdapters,
} from "./testUtils/channelRuntime.ts";
import * as Effect from "effect/Effect";
import { it } from "@effect/vitest";
import { describe, expect, vi } from "vite-plus/test";

describe("channel runtime", () => {
  it.effect.each([
    { status: 200, data: { ok: false, error: "missing_scope", detail: "secret-token" } },
    { status: 200, data: { ok: false, error: "channel_not_found" } },
    { status: 200, data: { ok: false, error: "invalid_auth" } },
    { status: 200, data: { ok: false, error: "ratelimited" } },
    { status: 429, data: {}, headers: { "retry-after": "1" } },
  ])("retries a verified Slack API rejection through the shipped post wrapper: %j", (response) =>
    Effect.gen(function* () {
      const { harness, input } = makeAdapterDeliveryHarness("slack", "slack:C123:1");
      externalAdapters.slackResponses.push(response, { status: 200, data: { ok: true, ts: "2" } });
      yield* connectChannel(harness.dependencies, slackConnect(BOT_ID));
      expect(externalAdapters.slackRetryOptions).toEqual({
        retries: 0,
        rejectRateLimitedCalls: true,
      });
      const failure = yield* failureOf(sendChannelMessage(harness.dependencies, input));
      expect(failure).toMatchObject({
        name: "ChannelPostRejectedError",
        message: "The channel rejected this reply. Correct the channel problem, then retry.",
      });
      expect(failure).not.toHaveProperty("cause");
      expect(harness.readModel().bots[0]?.channelBindings[0]?.lastError).not.toContain(
        "secret-token",
      );
      yield* sendChannelMessage(harness.dependencies, input);
      yield* sendChannelMessage(harness.dependencies, input);
      expect(externalAdapters.slackPostRequests).toBe(2);
      expect(harness.readModel().bots[0]?.channelBindings[0]?.lastError).toBeUndefined();
    }),
  );

  it.effect.each([
    { status: 400, code: 50035 },
    { status: 401, code: 50014 },
    { status: 403, code: 50013 },
    { status: 404, code: 10003 },
    { status: 429, code: 20028 },
  ])(
    "retries a verified Discord API rejection through the shipped post wrapper: %j",
    ({ status, code }) =>
      Effect.gen(function* () {
        const { harness, input } = makeAdapterDeliveryHarness("discord", "discord:123:456");

        const fetch = vi
          .fn<typeof globalThis.fetch>()
          .mockResolvedValueOnce(Response.json({ code, message: "secret-token" }, { status }))
          .mockResolvedValueOnce(Response.json({ id: "discord-sent" }));

        vi.stubGlobal("fetch", fetch);
        yield* connectChannel(harness.dependencies, discordConnect(BOT_ID));
        expect(yield* failureOf(sendChannelMessage(harness.dependencies, input))).toMatchObject({
          _tag: "ChannelPostRejectedError",
        });
        expect(harness.readModel().bots[0]?.channelBindings[0]?.lastError).not.toContain(
          "secret-token",
        );
        yield* sendChannelMessage(harness.dependencies, input);
        yield* sendChannelMessage(harness.dependencies, input);
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(fetch.mock.calls[0]?.[0]).toBe("https://discord.com/api/v10/channels/456/messages");
      }),
  );

  it.effect.each([
    new Error("timeout secret-token; DiscordApiError 403"),
    { status: 503, body: { code: 50013, message: "secret-token" } },
    { status: 403, body: { message: "secret-token" } },
    { status: 400, body: { code: 99999, message: "secret-token" } },
    { status: 408, body: { code: 50035, message: "secret-token" } },
  ])("retains an unverified Discord failure through the shipped post wrapper: %j", (failure) =>
    Effect.gen(function* () {
      const { harness, input } = makeAdapterDeliveryHarness("discord", "discord:123:456");
      const fetch = vi.fn<typeof globalThis.fetch>();

      if (failure instanceof Error) fetch.mockRejectedValue(failure);
      else fetch.mockResolvedValue(Response.json(failure.body, { status: failure.status }));
      vi.stubGlobal("fetch", fetch);
      yield* connectChannel(harness.dependencies, discordConnect(BOT_ID));
      yield* expectFailureMessage(
        sendChannelMessage(harness.dependencies, input),
        "This channel reply has an unfinished delivery attempt. Check the channel before sending another reply.",
      );
      yield* expectFailureMessage(
        sendChannelMessage(harness.dependencies, input),
        "unfinished delivery attempt",
      );
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(harness.readModel().bots[0]?.channelBindings[0]?.sentMessageIds).toEqual([]);
    }),
  );

  it.effect.each([401, 403, 404, 429])(
    "retries a verified Telegram %i rejection through the shipped post wrapper",
    (status) =>
      Effect.gen(function* () {
        const { harness, input } = makeAdapterDeliveryHarness("telegram", "telegram:123");

        const sends = mockTelegramDelivery([
          Response.json({ ok: false, error_code: status, description: "secret-token" }, { status }),
          Response.json({
            ok: true,
            result: {
              message_id: 101,
              date: 1,
              chat: { id: 123, type: "private" },
              text: "Reply",
              from: { id: 1, is_bot: true, first_name: "Akeru" },
            },
          }),
        ]);

        yield* connectChannel(harness.dependencies, telegramConnect(BOT_ID));
        expect(yield* failureOf(sendChannelMessage(harness.dependencies, input))).toMatchObject({
          _tag: "ChannelPostRejectedError",
        });
        expect(harness.readModel().bots[0]?.channelBindings[0]?.lastError).not.toContain(
          "secret-token",
        );
        yield* sendChannelMessage(harness.dependencies, input);
        yield* sendChannelMessage(harness.dependencies, input);
        expect(sends).toHaveBeenCalledTimes(2);
      }),
  );

  it.effect.each([
    new Error("network timeout secret-token"),
    Response.json({ ok: false, error_code: 500, description: "secret-token" }, { status: 500 }),
    Response.json({ ok: false, error_code: 400, description: "secret-token" }, { status: 400 }),
  ])("retains an unverified Telegram failure through the shipped post wrapper: %j", (response) =>
    Effect.gen(function* () {
      const { harness, input } = makeAdapterDeliveryHarness("telegram", "telegram:123");
      const sends = mockTelegramDelivery([response]);
      yield* connectChannel(harness.dependencies, telegramConnect(BOT_ID));
      yield* expectFailureMessage(
        sendChannelMessage(harness.dependencies, input),
        "This channel reply has an unfinished delivery attempt. Check the channel before sending another reply.",
      );
      yield* expectFailureMessage(
        sendChannelMessage(harness.dependencies, input),
        "unfinished delivery attempt",
      );
      expect(sends).toHaveBeenCalledTimes(1);
    }),
  );

  it.effect("retains a partial WhatsApp post when a later chunk is rejected", () =>
    Effect.gen(function* () {
      const { harness, input } = makeAdapterDeliveryHarness(
        "whatsapp",
        "whatsapp:phone-number-id:15551234567",
        "x".repeat(5000),
      );

      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValueOnce(Response.json({ messages: [{ id: "first-chunk" }] }))
        .mockResolvedValueOnce(
          Response.json({ error: { code: 190, message: "secret-token" } }, { status: 401 }),
        );

      vi.stubGlobal("fetch", fetch);
      yield* connectChannel(harness.dependencies, whatsappConnect(BOT_ID));
      yield* expectFailureMessage(
        sendChannelMessage(harness.dependencies, input),
        "This channel reply has an unfinished delivery attempt. Check the channel before sending another reply.",
      );
      yield* expectFailureMessage(
        sendChannelMessage(harness.dependencies, input),
        "unfinished delivery attempt",
      );
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(harness.readModel().bots[0]?.channelBindings[0]?.sentMessageIds).toEqual([]);
    }),
  );
});
