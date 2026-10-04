import * as Match from "effect/Match";
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
import * as ModelCatalog from "./ModelCatalog.ts";
import {
  BUNDLED_MODEL_CATALOG,
  catalogModelsFor,
  harnessEffortLevels,
  type CatalogModel,
} from "./modelCatalogData.ts";
import type { ServerProviderDraft } from "./providerSnapshot.ts";
import { getClaudeModelCapabilities } from "./Layers/ClaudeProvider.ts";

export const GROK_HARNESS_MODELS = [
  "grok-4.6",
  "grok-4.5",
  "grok-4",
  "grok-4.20-beta",
  "grok-code-fast-1",
] as const;

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

/**
 * Readable picker name for a harness model slug that has no catalog entry:
 * `gpt-6.1-sol` becomes "GPT-6.1 Sol" and `claude-opus-5-5` becomes
 * "Claude Opus 5.5".
 */
export function harnessModelName(slug: string): string {
  const words: string[] = [];

  for (const part of slug.split("-")) {
    const previous = words.at(-1);

    if (/^\d{1,2}$/.test(part) && previous && /^\d+(\.\d+)*$/.test(previous)) {
      words[words.length - 1] = `${previous}.${part}`;
    } else if (/^\d/.test(part) && previous === "GPT") {
      words[words.length - 1] = `GPT-${part}`;
    } else if (part === "gpt") {
      words.push("GPT");
    } else {
      words.push(/^\d/.test(part) ? part : part.charAt(0).toUpperCase() + part.slice(1));
    }
  }

  return words.join(" ");
}

/** Codex model ids: the catalog's, newest first, then historical slugs that
 * saved threads may still reference. */
export function codexHarnessModelIds(catalogIds: ReadonlyArray<string>): string[] {
  return [
    ...new Set([
      ...catalogIds,
      ...catalogModelsFor(BUNDLED_MODEL_CATALOG, ProviderDriverKind.make("codex")).map(
        (model) => model.id,
      ),
      ...CODEX_HARNESS_HISTORICAL_MODELS,
    ]),
  ];
}

const effortLabel = (level: string) =>
  level === "xhigh" ? "Extra High" : level[0]!.toUpperCase() + level.slice(1);

/**
 * Codex option descriptors. Catalog models offer exactly the efforts and
 * service tiers models.dev lists; slugs outside the catalog fall back to
 * Mastra's per-model thinking levels and always offer Fast.
 */
export function codexModelCapabilities(slug: string, entry: CatalogModel | undefined) {
  // The Codex transport downgrades `max` to `xhigh` for models the harness
  // SDK does not know support it, so only offer levels it will actually send.
  const supported: ReadonlyArray<string> = getAvailableThinkingLevelsForModel(`openai/${slug}`);

  const levels =
    entry?.efforts !== undefined
      ? harnessEffortLevels(entry.efforts).filter((level) => supported.includes(level))
      : supported;

  const defaultLevel = levels.includes("medium") ? "medium" : levels[0];

  return createModelCapabilities({
    optionDescriptors: [
      ...(defaultLevel === undefined
        ? []
        : [
            {
              id: "reasoningEffort",
              label: "Reasoning",
              type: "select" as const,
              currentValue: defaultLevel,
              options: levels.map((level) => ({
                id: level,
                label: effortLabel(level),
                ...(level === defaultLevel ? { isDefault: true } : {}),
              })),
            },
          ]),
      ...(entry === undefined || entry.fast === true
        ? [
            {
              id: "serviceTier",
              label: "Service Tier",
              type: "select" as const,
              currentValue: "default",
              options: [
                { id: "default", label: "Standard", isDefault: true },
                { id: "priority", label: "Fast" },
              ],
            },
          ]
        : []),
    ],
  });
}

export function harnessCredentialIssue(
  driver: ProviderDriverKind,
  connection: NonNullable<ProviderInstance["mastraConnection"]>,
  savedCredentialConnected: boolean,
): string | undefined {
  const environment = connection.useSavedCredential
    ? connection.environment
    : connection.instanceEnvironment;

  const connected = Match.value(driver).pipe(
    Match.when("codex", () => Boolean(environment.OPENAI_API_KEY?.trim())),
    Match.when("claudeAgent", () =>
      Boolean(
        environment.ANTHROPIC_API_KEY?.trim() ||
        environment.ANTHROPIC_AUTH_TOKEN?.trim() ||
        environment.CLAUDE_CODE_OAUTH_TOKEN?.trim(),
      ),
    ),
    Match.orElse(() => Boolean(environment.XAI_API_KEY?.trim())),
  );

  if (connected || (connection.useSavedCredential && savedCredentialConnected)) return undefined;

  if (connection.useSavedCredential) {
    const name = Match.value(driver).pipe(
      Match.when("codex", () => "ChatGPT"),
      Match.when("claudeAgent", () => "Claude"),
      Match.orElse(() => "Grok"),
    );

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
  const modelCatalog = yield* ModelCatalog.ModelCatalog;

  const checkProvider = Effect.gen(function* () {
    yield* auth.reload();
    yield* modelCatalog.refreshInBackground;
    const catalog = yield* modelCatalog.current;
    const { message: _draftMessage, ...draft } = yield* input.draft;

    const message = harnessCredentialIssue(
      input.driver,
      input.connection,
      auth.isConnected(input.provider, input.instanceId),
    );

    const entries = new Map(
      catalogModelsFor(catalog, input.driver).map((model) => [model.id, model]),
    );

    const catalogIds = [...entries.keys()];

    const modelIds =
      input.driver === "codex"
        ? codexHarnessModelIds(catalogIds)
        : [...new Set([...catalogIds, ...(input.driver === "grok" ? GROK_HARNESS_MODELS : [])])];

    const models = [
      ...draft.models
        .filter((model) => !model.isCustom || !modelIds.includes(model.slug))
        .map((model) => {
          const name = model.isCustom ? undefined : entries.get(model.slug)?.name;

          return name ? { ...model, name } : model;
        }),
      ...modelIds
        .filter((slug) => !draft.models.some((model) => !model.isCustom && model.slug === slug))
        .map((slug, index) => ({
          slug,
          name: entries.get(slug)?.name ?? harnessModelName(slug),
          isCustom: false,
          ...(index === 0 && !draft.models.some((model) => !model.isCustom)
            ? { isDefault: true }
            : {}),
          capabilities: Match.value(input.driver).pipe(
            Match.when("codex", () => codexModelCapabilities(slug, entries.get(slug))),
            Match.when("claudeAgent", () => getClaudeModelCapabilities(slug)),
            Match.orElse(() => null),
          ),
        })),
    ];

    const classified = ModelCatalog.applyModelCatalog(
      {
        ...draft,
        installed: true,
        availability: "available",
        version: null,
        checkedAt: DateTime.formatIso(yield* DateTime.now),
        status: !draft.enabled ? "disabled" : message ? "warning" : "ready",
        auth: { status: message ? "unauthenticated" : "authenticated" },
        ...(draft.enabled && message ? { message } : {}),
        models,
        slashCommands: [],
        skills: [],
      },
      catalog,
      input.driver,
    );

    // `grok-build` is Akeru's alias for the Grok model the harness runs by
    // default. models.dev does not list the alias, so keep it current.
    return input.driver === "grok"
      ? {
          ...classified,
          models: classified.models.map((model) => {
            if (model.slug !== "grok-build" || model.isCustom) return model;
            const { isLegacy: _isLegacy, ...rest } = model;

            return { ...rest, name: "Grok 4.6", isDefault: true };
          }),
        }
      : classified;
  });

  return { checkProvider };
});
