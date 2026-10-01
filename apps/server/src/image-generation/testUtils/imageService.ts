// @effect-diagnostics nodeBuiltinImport:off globalDate:off preferSchemaOverJson:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeCrypto from "node:crypto";
import {
  ImageGenerationSettingsPatch,
  ServerSettings,
  type ImageGenerationSettings,
  type ImageProviderId,
} from "@akeru/contracts";
import * as Schema from "effect/Schema";
import { SubscriptionAuthService } from "../../subscription-auth/service.ts";
import { imageProviderStatuses } from "../service.ts";

const decodeServerSettings = Schema.decodeUnknownSync(ServerSettings);

const encodeServerSettings = Schema.encodeSync(ServerSettings);

const decodeImagePatch = Schema.decodeUnknownExit(ImageGenerationSettingsPatch);

function fixture() {
  const directory = NodePath.join(NodeOS.tmpdir(), `akeru-image-gen-${NodeCrypto.randomUUID()}`);
  NodeFS.mkdirSync(directory, { recursive: true });
  return { directory, authPath: NodePath.join(directory, "subscription-auth.json") };
}

function seedOAuth(authPath: string, provider: string) {
  const existing = NodeFS.existsSync(authPath)
    ? (JSON.parse(NodeFS.readFileSync(authPath, "utf-8")) as Record<string, unknown>)
    : {};
  existing[provider] = {
    type: "oauth",
    access: `${provider}-expired-access`,
    refresh: `${provider}-refresh`,
    accountId: "chatgpt-test-account",
    expires: 0,
  };
  NodeFS.writeFileSync(authPath, JSON.stringify(existing));
}

function seedChatGptSignIn(authPath: string) {
  const existing = NodeFS.existsSync(authPath)
    ? (JSON.parse(NodeFS.readFileSync(authPath, "utf-8")) as Record<string, unknown>)
    : {};
  existing["openai-codex"] = {
    type: "oauth",
    access: "chatgpt-access",
    refresh: "chatgpt-refresh",
    expires: Date.now() + 3_600_000,
    accountId: "acct-123",
  };
  NodeFS.writeFileSync(authPath, JSON.stringify(existing));
}

function seedApiKey(authPath: string, provider: string, access = `${provider}-key`) {
  const existing = NodeFS.existsSync(authPath)
    ? (JSON.parse(NodeFS.readFileSync(authPath, "utf-8")) as Record<string, unknown>)
    : {};
  existing[provider] = { type: "api-key", access };
  NodeFS.writeFileSync(authPath, JSON.stringify(existing));
}

const baseSettings: ImageGenerationSettings = {
  chatgptEnabled: false,
  grokEnabled: false,
  defaultProvider: null,
  fallbackOrder: ["chatgpt", "grok"],
};

function rows(service: SubscriptionAuthService, settings: ImageGenerationSettings) {
  return imageProviderStatuses({
    settings,
    subscriptionStatuses: service.statuses(),
    chatgptAccountConnected: service.hasOpenAICodexAccount(),
    requestHealth: (provider: ImageProviderId) => service.imageRequestHealth(provider),
  });
}
export {
  decodeServerSettings,
  encodeServerSettings,
  decodeImagePatch,
  fixture,
  seedOAuth,
  seedChatGptSignIn,
  seedApiKey,
  baseSettings,
  rows,
};
