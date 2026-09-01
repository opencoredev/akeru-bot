import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/unstable/http";

import {
  buildDiscordReleaseAnnouncement,
  isDiscordReleaseAnnouncementError,
  postDiscordWebhook,
} from "./notify-discord-release.ts";

const latestAnnouncement = {
  target: "latest",
  roleId: "222222222222222222",
  releaseName: "T3 Code v1.2.3",
  version: "1.2.3",
  tag: "v1.2.3",
  releaseUrl: new URL("https://github.com/t3dotgg/t3-code/releases/tag/v1.2.3"),
  timestamp: "2026-05-01T01:41:00.000Z",
} as const;

const webhookUrl = new URL("https://discord.com/api/webhooks/123456/secret-token");

it("builds a latest Discord announcement for stable subscribers", () => {
  assert.deepStrictEqual(buildDiscordReleaseAnnouncement(latestAnnouncement), {
    content: "<@&222222222222222222> Latest published: T3 Code v1.2.3",
    allowed_mentions: {
      roles: ["222222222222222222"],
    },
    embeds: [
      {
        title: "T3 Code v1.2.3",
        url: "https://github.com/t3dotgg/t3-code/releases/tag/v1.2.3",
        description: "A new Akeru Bot latest release is available.",
        color: 0x2ecc71,
        fields: [
          {
            name: "Version",
            value: "1.2.3",
            inline: true,
          },
          {
            name: "Tag",
            value: "v1.2.3",
            inline: true,
          },
        ],
        timestamp: "2026-05-01T01:41:00.000Z",
      },
    ],
  });
});

it.effect("preserves webhook request context and the full client cause chain", () => {
  const payload = buildDiscordReleaseAnnouncement(latestAnnouncement);
  const requestCause = new Error("request encoder unavailable");
  let clientError: HttpClientError.HttpClientError | undefined;
  const httpClientLayer = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      clientError = new HttpClientError.HttpClientError({
        reason: new HttpClientError.EncodeError({
          request,
          cause: requestCause,
        }),
      });
      return Effect.fail(clientError);
    }),
  );

  return Effect.gen(function* () {
    const error = yield* postDiscordWebhook(webhookUrl, payload, latestAnnouncement).pipe(
      Effect.provide(httpClientLayer),
      Effect.flip,
    );

    if (error._tag !== "DiscordReleaseWebhookRequestError") {
      assert.fail(`Unexpected error: ${error._tag}`);
    }
    assert.equal(error.target, "latest");
    assert.equal(error.releaseName, latestAnnouncement.releaseName);
    assert.equal(error.version, latestAnnouncement.version);
    assert.equal(error.tag, latestAnnouncement.tag);
    assert.equal(error.releaseUrl, latestAnnouncement.releaseUrl.href);
    assert.equal(error.webhookOrigin, webhookUrl.origin);
    assert.equal(error.webhookPathnameSegmentCount, 4);
    assert.equal(error.contentLength, payload.content.length);
    assert.equal(error.embedCount, 1);
    assert.equal(error.allowedRoleMentionCount, 1);
    assert.equal(error.hasRoleMentionSyntax, true);
    assert.equal(error.cause, clientError);
    assert.equal((error.cause as HttpClientError.HttpClientError).cause, requestCause);
    assert.ok(!error.message.includes(requestCause.message));
    assert.equal(isDiscordReleaseAnnouncementError(error), true);
  });
});

it.effect("preserves a non-success response error with structured status context", () => {
  const payload = buildDiscordReleaseAnnouncement(latestAnnouncement);
  const httpClientLayer = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(request, new Response("invalid webhook", { status: 400 })),
      ),
    ),
  );

  return Effect.gen(function* () {
    const error = yield* postDiscordWebhook(webhookUrl, payload, latestAnnouncement).pipe(
      Effect.provide(httpClientLayer),
      Effect.flip,
    );

    if (error._tag !== "DiscordReleaseWebhookResponseError") {
      assert.fail(`Unexpected error: ${error._tag}`);
    }
    assert.equal(error.target, "latest");
    assert.equal(error.tag, latestAnnouncement.tag);
    assert.equal(error.webhookOrigin, webhookUrl.origin);
    assert.equal(error.webhookPathnameSegmentCount, 4);
    assert.equal(error.status, 400);
    if (!HttpClientError.isHttpClientError(error.cause)) {
      assert.fail("Expected HttpClientError cause");
    }
    assert.equal(error.cause.reason._tag, "StatusCodeError");
    assert.ok(!error.message.includes(error.cause.message));
    assert.equal(isDiscordReleaseAnnouncementError(error), true);
  });
});
