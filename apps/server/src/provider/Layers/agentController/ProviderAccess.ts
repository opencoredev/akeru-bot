import { ProviderDriverKind } from "@akeru/contracts";
import { ProviderInstanceId } from "@akeru/contracts";
import * as NodeCrypto from "node:crypto";
import * as Path from "effect/Path";
import * as Effect from "effect/Effect";
import { AuthStorage } from "@mastra/code-sdk/auth/storage";
import { type ProviderRuntimeEvent } from "@akeru/contracts";
import {
  SubscriptionAuthService,
  type SubscriptionProviderId,
} from "../../../subscription-auth/service.ts";
import { openCodeGoInlineConnection } from "../../AkeruMastraHarness.ts";
import type { ProviderInstanceRoutingInfo } from "../../Services/ProviderAdapterRegistry.ts";
import { type AkeruDelegationRuntimeOptions } from "../../AkeruDelegationRuntime.ts";

import { nowIso, eventId } from "./EventIdentity.ts";

export const createAkeruMastraAuthStorage = Effect.fn("createAkeruMastraAuthStorage")(function* (
  secretsDir: string,
) {
  const path = yield* Path.Path;

  return new AuthStorage(path.join(secretsDir, "subscription-auth.json"));
});

export type DelegatedUsage = Parameters<
  NonNullable<AkeruDelegationRuntimeOptions["recordUsage"]>
>[0];

export function delegatedUsageReceipt(
  usage: DelegatedUsage,
  active: {
    readonly provider: ProviderDriverKind;
    readonly providerInstanceId: ProviderInstanceId;
  },
  createdAt = nowIso(),
): Extract<ProviderRuntimeEvent, { readonly type: "tool.receipt" }> {
  return {
    eventId: eventId(),
    provider: active.provider,
    providerInstanceId: active.providerInstanceId,
    threadId: usage.threadId,
    ...(usage.turnId ? { turnId: usage.turnId } : {}),
    createdAt,
    type: "tool.receipt",
    payload: {
      receiptId: `delegation:usage:${NodeCrypto.randomUUID()}`,
      toolId: "SendToAgent",
      phase: "success",
      threadId: usage.threadId,
      botId: usage.botId,
      billedBotId: usage.botId,
      fatalToThread: false,
      usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens },
      createdAt,
    },
  };
}

export function subscriptionProviderForDriver(
  provider: ProviderDriverKind,
): SubscriptionProviderId | undefined {
  switch (String(provider)) {
    case "codex":
      return "openai-codex";
    case "claudeAgent":
      return "anthropic";
    case "grok":
      return "xai";
    case "kimi":
      return "kimi-for-coding";
    case "opencodeGo":
      return "opencode-go";
    default:
      return undefined;
  }
}

export function mastraConnectionIssue(
  provider: ProviderDriverKind,
  connection: ProviderInstanceRoutingInfo["mastraConnection"],
  savedCredentialConnected: boolean,
): string | undefined {
  if (!connection) return undefined;

  const env = connection.useSavedCredential
    ? connection.environment
    : connection.instanceEnvironment;

  if (connection.useSavedCredential) {
    const hasAmbientCredential = (() => {
      switch (String(provider)) {
        case "codex":
          return Boolean(env.OPENAI_API_KEY?.trim());
        case "claudeAgent":
          return Boolean(
            env.ANTHROPIC_API_KEY?.trim() ||
            env.ANTHROPIC_AUTH_TOKEN?.trim() ||
            env.CLAUDE_CODE_OAUTH_TOKEN?.trim(),
          );
        case "grok":
          return Boolean(env.XAI_API_KEY?.trim());
        case "opencodeGo":
          return Boolean(env.OPENCODE_API_KEY?.trim() || openCodeGoInlineConnection(env).apiKey);
        default:
          return false;
      }
    })();

    if (hasAmbientCredential) return undefined;

    return savedCredentialConnected
      ? undefined
      : `Connect ${provider} in Settings before starting.`;
  }

  switch (String(provider)) {
    case "codex":
      return env.OPENAI_API_KEY?.trim()
        ? undefined
        : "This Codex instance needs OPENAI_API_KEY for the Akeru harness.";
    case "claudeAgent":
      return env.ANTHROPIC_API_KEY?.trim() ||
        env.ANTHROPIC_AUTH_TOKEN?.trim() ||
        env.CLAUDE_CODE_OAUTH_TOKEN?.trim()
        ? undefined
        : "This Claude instance needs an API key or auth token for the Akeru harness.";
    case "grok":
      return env.XAI_API_KEY?.trim()
        ? undefined
        : "This Grok instance needs XAI_API_KEY for the Akeru harness.";
    case "kimi":
      return "Custom Kimi credentials are not supported by the Akeru harness.";
    case "opencodeGo":
      return env.OPENCODE_API_KEY?.trim() || openCodeGoInlineConnection(env).apiKey
        ? undefined
        : "This OpenCode Go instance needs OPENCODE_API_KEY for the Akeru harness.";
    default:
      return `Provider '${provider}' has no Akeru Mastra transport.`;
  }
}

export function recordProviderAccessHealth(
  subscriptionAuth: SubscriptionAuthService,
  event: ProviderRuntimeEvent,
  model?: string,
): void {
  const provider = subscriptionProviderForDriver(event.provider);
  const providerInstanceId = event.providerInstanceId;

  if (event.type === "turn.completed") {
    if (event.payload.state === "failed") {
      const message = event.payload.errorMessage ?? "The provider request failed.";

      if (provider) {
        if (providerInstanceId)
          subscriptionAuth.recordAccountRequestFailure(
            provider,
            providerInstanceId,
            message,
            event.createdAt,
          );
        else subscriptionAuth.recordRequestFailure(provider, message, event.createdAt);
      }

      if (providerInstanceId) {
        subscriptionAuth.recordProviderInstanceFailure(
          providerInstanceId,
          message,
          event.createdAt,
          model,
        );
      }
    } else if (event.payload.state === "completed") {
      if (provider) {
        if (providerInstanceId)
          subscriptionAuth.recordAccountRequestSuccess(
            provider,
            providerInstanceId,
            event.createdAt,
          );
        else subscriptionAuth.recordRequestSuccess(provider, event.createdAt);
      }

      if (providerInstanceId) {
        subscriptionAuth.recordProviderInstanceSuccess(providerInstanceId, event.createdAt);
      }
    }

    return;
  }

  if (event.type !== "runtime.error" || event.payload.class !== "provider_error") return;

  if (provider) {
    if (providerInstanceId)
      subscriptionAuth.recordAccountRequestFailure(
        provider,
        providerInstanceId,
        event.payload.message,
        event.createdAt,
      );
    else subscriptionAuth.recordRequestFailure(provider, event.payload.message, event.createdAt);
  }

  if (providerInstanceId) {
    subscriptionAuth.recordProviderInstanceFailure(
      providerInstanceId,
      event.payload.message,
      event.createdAt,
      model,
    );
  }
}
