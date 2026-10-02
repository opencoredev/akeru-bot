import {
  connectChannel,
  handleWhatsAppWebhook,
  BOT_ID,
  makeHarness,
  whatsappConnect,
  signedWhatsAppRequest,
} from "./testUtils/channelRuntime.ts";
import * as Effect from "effect/Effect";
import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";

describe("channel runtime", () => {
  it.effect("verifies WhatsApp webhook challenges", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ startTransport: null });
      yield* connectChannel(harness.dependencies, whatsappConnect(BOT_ID));

      const accepted = yield* handleWhatsAppWebhook(
        BOT_ID,
        new Request(
          `https://akeru.example/api/channels/whatsapp/${BOT_ID}/webhook?hub.mode=subscribe&hub.verify_token=verify-token&hub.challenge=challenge-123`,
        ),
      );

      const rejected = yield* handleWhatsAppWebhook(
        BOT_ID,
        new Request(
          `https://akeru.example/api/channels/whatsapp/${BOT_ID}/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=challenge-123`,
        ),
      );

      expect(accepted.status).toBe(200);
      expect(yield* Effect.promise(() => accepted.text())).toBe("challenge-123");
      expect(rejected.status).toBe(403);
    }),
  );

  it.effect("keeps the bot-addressed WhatsApp webhook to its own phone number", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ startTransport: null });
      yield* connectChannel(harness.dependencies, whatsappConnect(BOT_ID));

      const change = (phoneNumberId: string, messageId: string) => ({
        field: "messages",
        value: {
          messaging_product: "whatsapp",
          metadata: {
            display_phone_number: "+15550002222",
            phone_number_id: phoneNumberId,
          },
          contacts: [{ profile: { name: "Mallory" }, wa_id: "15557654321" }],
          messages: [
            {
              from: "15557654321",
              id: messageId,
              timestamp: "1788220000",
              text: { body: `Message ${messageId}` },
              type: "text",
            },
          ],
        },
      });

      const batch = (...changes: ReadonlyArray<ReturnType<typeof change>>) =>
        JSON.stringify({
          object: "whatsapp_business_account",
          entry: [{ id: "business-id", changes }],
        });

      const otherLine = yield* handleWhatsAppWebhook(
        BOT_ID,
        signedWhatsAppRequest(batch(change("other-phone-number-id", "wamid.other-line"))),
      );

      const oversized = yield* handleWhatsAppWebhook(
        BOT_ID,
        signedWhatsAppRequest(" ".repeat(1024 * 1024 + 1)),
      );

      expect(otherLine.status).toBe(404);
      expect(oversized.status).toBe(413);
      expect(harness.commands.some((command) => command.type === "thread.turn.start")).toBe(false);

      // A batch for two numbers still delivers the message for this bot's number.
      const mixed = yield* handleWhatsAppWebhook(
        BOT_ID,
        signedWhatsAppRequest(
          batch(
            change("other-phone-number-id", "wamid.mixed-other"),
            change("phone-number-id", "wamid.mixed-own"),
          ),
        ),
      );

      expect(mixed.status).toBe(200);
      const turns = harness.commands.filter((command) => command.type === "thread.turn.start");
      expect(
        turns.map((turn) =>
          turn.type === "thread.turn.start" ? turn.message.channelOrigin?.externalMessageId : null,
        ),
      ).toEqual(["wamid.mixed-own"]);
    }),
  );
});
