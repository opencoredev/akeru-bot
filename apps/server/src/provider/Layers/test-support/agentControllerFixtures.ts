import { ProviderInstanceId, ThreadId } from "@akeru/contracts";

export const codexThreadId = ThreadId.make("thread-mastra-codex");

export const claudeThreadId = ThreadId.make("thread-mastra-claude");

export const grokThreadId = ThreadId.make("thread-mastra-grok");

export const kimiThreadId = ThreadId.make("thread-mastra-kimi");

export const openCodeGoThreadId = ThreadId.make("thread-mastra-opencode-go");

export const codexInstanceId = ProviderInstanceId.make("codex");

export const claudeInstanceId = ProviderInstanceId.make("claudeAgent");

export const grokInstanceId = ProviderInstanceId.make("grok");

export const openCodeInstanceId = ProviderInstanceId.make("opencode");

export const kimiInstanceId = ProviderInstanceId.make("kimi-custom");

export const openCodeGoInstanceId = ProviderInstanceId.make("opencodeGo");

export const codexSelection = {
  instanceId: codexInstanceId,
  model: "gpt-5.6-sol",
};

export const instanceModelCatalog = new Map<
  string,
  { readonly models: ReadonlyArray<string>; readonly status?: "ready" | "warning" | "error" }
>();
