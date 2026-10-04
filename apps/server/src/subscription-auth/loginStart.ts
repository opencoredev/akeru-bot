import * as NodeCrypto from "node:crypto";
import type { SubscriptionAuthStartInput } from "@akeru/contracts";
import { startAnthropicLogin } from "./providers/anthropic.ts";
import { startCodexDeviceLogin } from "./providers/openaiCodex.ts";
import { startKimiDeviceLogin } from "./providers/kimi.ts";
import { startXAIDeviceLogin } from "./providers/xai.ts";
import {
  decodeBaseUrl,
  OPENCODE_GO_AUTH_URL,
  PENDING_LOGIN_CAP,
  type BoundLogin,
  type StartedLogin,
  type SubscriptionProviderId,
} from "./serviceTypes.ts";

interface LoginStartContext {
  readonly reloadAsync: () => Promise<void>;
  readonly loginScope: (
    provider: SubscriptionProviderId,
    options: Omit<SubscriptionAuthStartInput, "provider">,
  ) => string;
  readonly pendingLogins: Map<string, BoundLogin>;
  readonly savePending: () => void;
}

export async function startSubscriptionLogin(
  context: LoginStartContext,
  provider: SubscriptionProviderId,
  options: Omit<SubscriptionAuthStartInput, "provider"> = {},
): Promise<StartedLogin> {
  await context.reloadAsync();
  const authMode = options.authMode ?? (provider === "opencode-go" ? "api-key" : "oauth");

  if (options.baseUrl !== undefined && authMode !== "api-key") {
    throw new Error("Custom base URLs require API-key authentication. Select API key first.");
  }

  if (options.baseUrl !== undefined && provider === "xai") {
    throw new Error("The Grok bridge does not support custom base URLs. Use the default endpoint.");
  }

  if (authMode === "oauth" && provider === "opencode-go") {
    throw new Error("OpenCode Go requires an API key. Select API key first.");
  }

  const baseUrl =
    options.baseUrl === undefined ? undefined : decodeBaseUrl(options.baseUrl).replace(/\/+$/, "");

  const loginId = NodeCrypto.randomUUID();
  const binding = { instanceId: context.loginScope(provider, options) };
  let started: StartedLogin;

  if (authMode === "api-key") {
    context.pendingLogins.set(loginId, {
      provider,
      authMode,
      ...binding,
      ...(baseUrl ? { baseUrl } : {}),
    });
    started = {
      loginId,
      provider,
      url: provider === "opencode-go" ? OPENCODE_GO_AUTH_URL : "",
      instructions: "Paste the provider API key.",
      completion: "paste",
    };
  } else
    switch (provider) {
      case "anthropic": {
        const { url, verifier } = await startAnthropicLogin();
        context.pendingLogins.set(loginId, { provider, verifier, ...binding });
        started = { loginId, provider, url, completion: "paste" };
        break;
      }

      case "openai-codex": {
        const pending = await startCodexDeviceLogin();
        context.pendingLogins.set(loginId, { provider, pending, ...binding });
        started = {
          loginId,
          provider,
          url: pending.url,
          userCode: pending.userCode,
          instructions: pending.instructions,
          completion: "poll",
        };
        break;
      }

      case "xai": {
        const pending = await startXAIDeviceLogin();
        context.pendingLogins.set(loginId, { provider, pending, ...binding });
        started = {
          loginId,
          provider,
          url: pending.url,
          userCode: pending.userCode,
          instructions: pending.instructions,
          completion: "poll",
        };
        break;
      }

      case "kimi-for-coding": {
        const pending = await startKimiDeviceLogin();
        context.pendingLogins.set(loginId, { provider, pending, ...binding });
        started = {
          loginId,
          provider,
          url: pending.url,
          userCode: pending.userCode,
          instructions: pending.instructions,
          completion: "poll",
        };
        break;
      }

      case "opencode-go": {
        context.pendingLogins.set(loginId, { provider, ...binding });
        started = {
          loginId,
          provider,
          url: OPENCODE_GO_AUTH_URL,
          instructions: "Subscribe to OpenCode Go, copy the API key, then paste it here.",
          completion: "paste",
        };
        break;
      }
    }

  // Drop the oldest abandoned login rather than growing without bound.
  if (context.pendingLogins.size > PENDING_LOGIN_CAP) {
    const oldest = context.pendingLogins.keys().next().value;

    if (oldest !== undefined) context.pendingLogins.delete(oldest);
  }

  context.savePending();

  return started;
}
