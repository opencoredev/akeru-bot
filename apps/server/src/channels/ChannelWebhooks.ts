import * as NodeCrypto from "node:crypto";
import { BotId, ChannelConnectionId } from "@akeru/contracts";
import * as Effect from "effect/Effect";
import { type ChannelRuntimeContext } from "./ChannelRuntimeTypes.ts";
import {
  StoredChannelSecret,
  runtimeKey,
  loadSecret,
  loadConnectionSecret,
} from "./ChannelSecrets.ts";

export const encoder = new TextEncoder();

export const decoder = new TextDecoder();

export const WHATSAPP_WEBHOOK_PATH = "/api/channels/whatsapp/:botId/webhook";

export const WHATSAPP_CONNECTION_WEBHOOK_PATH =
  "/api/channels/whatsapp/connections/:connectionId/webhook";

/** Webhook URL Meta should call for a saved WhatsApp connection, or undefined without a public https origin. */
export const whatsAppWebhookUrl = (
  publicOrigin: string | undefined,
  connectionId: ChannelConnectionId,
) =>
  publicOrigin?.startsWith("https://")
    ? `${publicOrigin}${WHATSAPP_CONNECTION_WEBHOOK_PATH.replace(":connectionId", encodeURIComponent(connectionId))}`
    : undefined;

export const handleWhatsAppWebhook = (ctx: ChannelRuntimeContext, botId: BotId, request: Request) =>
  Effect.suspend(() => {
    const webhook = ctx.runtimes.get(runtimeKey(botId, "whatsapp"))?.webhook;

    return webhook ? webhook(request) : Effect.succeed(new Response("Not Found", { status: 404 }));
  }).pipe(
    Effect.catchCause(() =>
      Effect.succeed(new Response("Webhook processing failed", { status: 500 })),
    ),
  );

export // Meta's message webhooks are a few kilobytes; media arrives by reference, not inline.
const MAX_WHATSAPP_WEBHOOK_BYTES = 1024 * 1024;

export const WEBHOOK_TOO_LARGE = Symbol("webhook-too-large");

export /** Reads a webhook body without buffering more than the cap. */
const readBoundedWebhookBody = async (
  request: Request,
): Promise<Buffer | typeof WEBHOOK_TOO_LARGE> => {
  const declared = Number(request.headers.get("content-length"));

  if (Number.isFinite(declared) && declared > MAX_WHATSAPP_WEBHOOK_BYTES) return WEBHOOK_TOO_LARGE;
  const reader = request.body?.getReader();

  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let size = 0;

  for (;;) {
    const { done, value } = await reader.read();

    if (done) break;
    size += value.byteLength;

    if (size > MAX_WHATSAPP_WEBHOOK_BYTES) {
      void reader.cancel().catch(() => undefined);

      return WEBHOOK_TOO_LARGE;
    }

    chunks.push(value);
  }

  return Buffer.concat(chunks);
};

export const parseWebhookJson = (body: Buffer): unknown => {
  try {
    return JSON.parse(body.toString("utf8")) as unknown;
  } catch {
    return null;
  }
};

export /** Hands a webhook to the bot's transport only when its messages are for the saved phone number. */
const handlePhoneScopedWhatsAppWebhook = (
  ctx: ChannelRuntimeContext,
  botId: BotId,
  secret: StoredChannelSecret | null,
  request: Request,
): Effect.Effect<Response> => {
  if (!secret || secret.provider !== "whatsapp")
    return Effect.succeed(new Response("Not Found", { status: 404 }));

  if (request.method !== "POST") return handleWhatsAppWebhook(ctx, botId, request);

  return Effect.promise(() => readBoundedWebhookBody(request)).pipe(
    Effect.flatMap((body) => {
      if (body === WEBHOOK_TOO_LARGE) {
        return Effect.succeed(new Response("Payload Too Large", { status: 413 }));
      }

      const scoped = scopeWhatsAppWebhookToPhone(
        body,
        request.headers,
        secret.appSecret,
        secret.phoneNumberId,
      );

      return scoped === null
        ? Effect.succeed(new Response("Not Found", { status: 404 }))
        : handleWhatsAppWebhook(
            ctx,
            botId,
            new Request(request.url, {
              method: request.method,
              headers: scoped.headers,
              body: scoped.body,
            }),
          );
    }),
  );
};

export /** Serves the older bot-addressed webhook URL with the same phone check as connection URLs. */
const handleBotWhatsAppWebhook = (ctx: ChannelRuntimeContext, botId: BotId, request: Request) =>
  ctx.deps.readModel.pipe(
    Effect.map((model) =>
      model.bots
        .find((bot) => bot.id === botId && bot.archivedAt === null)
        ?.channelBindings?.find((binding) => binding.provider === "whatsapp"),
    ),
    Effect.flatMap((binding) =>
      binding?.connectionId
        ? loadConnectionSecret(ctx, binding.connectionId)
        : loadSecret(ctx, botId, "whatsapp"),
    ),
    Effect.flatMap((secret) => handlePhoneScopedWhatsAppWebhook(ctx, botId, secret, request)),
    Effect.catchCause(() => Effect.succeed(new Response("Not Found", { status: 404 }))),
  );

export const record = (value: unknown): Readonly<Record<string, unknown>> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;

export const whatsAppChangePhone = (change: unknown): unknown =>
  record(record(record(change)?.value)?.metadata)?.phone_number_id;

export const whatsAppSignature = (body: Buffer, appSecret: string) =>
  `sha256=${NodeCrypto.createHmac("sha256", appSecret).update(body).digest("hex")}`;

export /**
 * Keeps a webhook batch to the saved phone number. Meta can batch changes for
 * several numbers on one app, so changes for other numbers are dropped and the
 * trimmed body is signed again for the transport. Returns null when nothing in
 * a signed batch belongs to this number. An unsigned or badly signed body is
 * passed through untouched so the transport rejects it.
 */
const scopeWhatsAppWebhookToPhone = (
  body: Buffer,
  headers: Headers,
  appSecret: string,
  phoneNumberId: string,
): { readonly body: Buffer; readonly headers: Headers } | null => {
  const payload = record(parseWebhookJson(body));
  const entries = payload?.entry;

  if (!payload || !Array.isArray(entries)) return { body, headers };

  const otherPhone = (change: unknown) => {
    const phone = whatsAppChangePhone(change);

    return phone !== undefined && phone !== phoneNumberId;
  };

  const hasOtherPhone = entries.some((entry: unknown) => {
    const changes = record(entry)?.changes;

    return Array.isArray(changes) && changes.some(otherPhone);
  });

  if (!hasOtherPhone) return { body, headers };
  const presented = headers.get("x-hub-signature-256") ?? "";
  const expected = whatsAppSignature(body, appSecret);

  if (
    presented.length !== expected.length ||
    !NodeCrypto.timingSafeEqual(Buffer.from(presented), Buffer.from(expected))
  ) {
    return { body, headers };
  }

  const scopedEntries = entries.flatMap((entry: unknown) => {
    const current = record(entry);
    const changes = current?.changes;

    if (!current || !Array.isArray(changes)) return [entry];
    const kept = changes.filter((change: unknown) => !otherPhone(change));

    return kept.length > 0 ? [{ ...current, changes: kept }] : [];
  });

  if (scopedEntries.length === 0) return null;
  const scopedBody = Buffer.from(JSON.stringify({ ...payload, entry: scopedEntries }), "utf8");
  const scopedHeaders = new Headers(headers);
  scopedHeaders.set("x-hub-signature-256", whatsAppSignature(scopedBody, appSecret));
  scopedHeaders.delete("content-length");

  return { body: scopedBody, headers: scopedHeaders };
};
