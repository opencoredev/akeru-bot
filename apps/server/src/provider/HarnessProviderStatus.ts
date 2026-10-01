import {
  MODEL_SLUG_ALIASES_BY_PROVIDER,
  ProviderDriverKind,
  type ProviderInstanceId,
} from "@akeru/contracts";
import { getAvailableThinkingLevelsForModel } from "@mastra/code-sdk/thinking";
import { createModelCapabilities } from "@akeru/shared/model";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import {
  SubscriptionAuthService,
  type SubscriptionProviderId,
} from "../subscription-auth/service.ts";
import type { ProviderInstance } from "./ProviderDriver.ts";
import * as ModelManifest from "./ModelManifest.ts";
import type { ServerProviderDraft } from "./providerSnapshot.ts";

export const CODEX_HARNESS_HISTORICAL_MODELS = [
  ...Object.values(MODEL_SLUG_ALIASES_BY_PROVIDER[ProviderDriverKind.make("codex")] ?? {}),
  "gpt-5.4-mini",
  "gpt-5.4-pro",
  "gpt-5.5",
  "gpt-5.2-codex",
  "gpt-5.2",
  "gpt-5.1-codex-max",
  "gpt-5.1-codex-mini",
  "gpt-5.1-codex",
  "gpt-5.1",
  "gpt-5-codex",
  "gpt-5",
  "codex-mini-latest",
] as const;

export function codexHarnessModelIds(currentModels: ReadonlyArray<string>): string[] {
  return [
    ...new Set([
      ...currentModels,
      ...(ModelManifest.BUNDLED_MODEL_MANIFEST.currentModels.codex ?? []),
      ...CODEX_HARNESS_HISTORICAL_MODELS,
    ]),
  ];
}

export function harnessCredentialIssue(
  driver: ProviderDriverKind,
  connection: NonNullable<ProviderInstance["mastraConnection"]>,
  savedCredentialConnected: boolean,
): string | undefined {
  const environment = connection.useSavedCredential
    ? connection.environment
    : connection.instanceEnvironment;
  const connected =
    driver === "codex"
      ? Boolean(environment.OPENAI_API_KEY?.trim())
      : driver === "claudeAgent"
        ? Boolean(
            environment.ANTHROPIC_API_KEY?.trim() ||
            environment.ANTHROPIC_AUTH_TOKEN?.trim() ||
            environment.CLAUDE_CODE_OAUTH_TOKEN?.trim(),
          )
        : Boolean(environment.XAI_API_KEY?.trim());
  if (connected || (connection.useSavedCredential && savedCredentialConnected)) return undefined;
  if (connection.useSavedCredential) {
    const name = driver === "codex" ? "ChatGPT" : driver === "claudeAgent" ? "Claude" : "Grok";
    return `Connect ${name} in Settings.`;
  }
  if (driver === "codex") return "This Codex instance needs OPENAI_API_KEY for the Akeru harness.";
  if (driver === "claudeAgent")
    return "This Claude instance needs an API key or auth token for the Akeru harness.";
  return "This Grok instance needs XAI_API_KEY for the Akeru harness.";
}

export const makeHarnessProviderStatus = Effect.fn("makeHarnessProviderStatus")(function* (input: {
  readonly secretsDir: string;
  readonly provider: SubscriptionProviderId;
  readonly driver: ProviderDriverKind;
  readonly instanceId: ProviderInstanceId;
  readonly connection: NonNullable<ProviderInstance["mastraConnection"]>;
  readonly draft: Effect.Effect<ServerProviderDraft>;
}) {
  const auth = yield* SubscriptionAuthService.forSecretsDir(input.secretsDir);
  const manifest = yield* ModelManifest.ModelManifest;
  return Effect.gen(function* () {
    yield* auth.reload();
    yield* manifest.refreshInBackground;
    const current = yield* manifest.current;
    const { message: _draftMessage, ...draft } = yield* input.draft;
    const message = harnessCredentialIssue(
      input.driver,
      input.connection,
      auth.isConnected(input.provider, input.instanceId),
    );
    const builtIn = draft.models.filter((model) => !model.isCustom);
    const currentModelIds = current.currentModels[input.driver];
    const modelIds =
      input.driver === "codex"
        ? codexHarnessModelIds(currentModelIds ?? [])
        : [
            ...new Set([
              ...(currentModelIds ?? []),
              ...(ModelManifest.BUNDLED_MODEL_MANIFEST.currentModels[input.driver] ?? []),
            ]),
          ];
    const models =
      builtIn.length > 0
        ? draft.models
        : [
            ...modelIds.map((slug, index) => ({
              slug,
              name: slug,
              isCustom: false,
              ...(index === 0 ? { isDefault: true } : {}),
              capabilities:
                input.driver === "codex"
                  ? createModelCapabilities({
                      optionDescriptors: [
                        {
                          id: "reasoningEffort",
                          label: "Reasoning",
                          type: "select",
                          currentValue: "medium",
                          options: getAvailableThinkingLevelsForModel(`openai/${slug}`).map(
                            (level) => ({
                              id: level,
                              label: level[0]!.toUpperCase() + level.slice(1),
                              ...(level === "medium" ? { isDefault: true } : {}),
                            }),
                          ),
                        },
                        {
                          id: "serviceTier",
                          label: "Service Tier",
                          type: "select",
                          currentValue: "default",
                          options: [
                            { id: "default", label: "Standard", isDefault: true },
                            { id: "priority", label: "Fast" },
                          ],
                        },
                      ],
                    })
                  : null,
            })),
            ...draft.models.filter((model) => !modelIds.includes(model.slug)),
          ];
    return ModelManifest.applyModelManifest(
      {
        ...draft,
        installed: true,
        availability: "available",
        version: null,
        checkedAt: DateTime.formatIso(yield* DateTime.now),
        status: !draft.enabled ? "disabled" : message ? "warning" : "ready",
        auth: { status: message ? "unauthenticated" : "authenticated" },
        ...(draft.enabled && message ? { message } : {}),
        models:
          input.driver === "grok"
            ? models.map((model) =>
                model.slug === "grok-build" && !model.isCustom
                  ? { ...model, name: "Grok 4.6", isDefault: true }
                  : model,
              )
            : models,
        slashCommands: [],
        skills: [],
      },
      current,
      input.driver,
    );
  });
});
