import * as Predicate from "effect/Predicate";
import {
  type ModelCapabilities,
  type ModelSelection,
  type ServerProviderModel,
} from "@akeru/contracts";
import {
  createModelCapabilities,
  getModelSelectionStringOptionValue,
  getProviderOptionCurrentValue,
  getProviderOptionDescriptors,
} from "@akeru/shared/model";
import { compareSemverVersions } from "@akeru/shared/semver";
import {
  buildBooleanOptionDescriptor,
  buildSelectOptionDescriptor,
} from "../../providerSnapshot.ts";

export const DEFAULT_CLAUDE_MODEL_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

export const MINIMUM_CLAUDE_OPUS_5_VERSION = "2.1.219";

export const MINIMUM_CLAUDE_FABLE_5_VERSION = "2.1.169";

export const MINIMUM_CLAUDE_OPUS_4_8_VERSION = "2.1.154";

export const MINIMUM_CLAUDE_OPUS_4_7_VERSION = "2.1.111";

const CLAUDE_FABLE_5_CAPABILITIES = createModelCapabilities({
  optionDescriptors: [
    buildSelectOptionDescriptor({
      id: "effort",
      label: "Reasoning",
      options: [
        { value: "low", label: "Low" },
        { value: "medium", label: "Medium" },
        { value: "high", label: "High", isDefault: true },
        { value: "xhigh", label: "Extra High" },
        { value: "max", label: "Max" },
        {
          value: "ultracode",
          label: "Ultracode",
          description: "xhigh effort plus multi-agent workflow orchestration",
        },
        { value: "ultrathink", label: "Ultrathink" },
      ],
      promptInjectedValues: ["ultrathink"],
    }),
    buildSelectOptionDescriptor({
      id: "contextWindow",
      label: "Context Window",
      options: [
        { value: "200k", label: "200k" },
        { value: "1m", label: "1M", isDefault: true },
      ],
    }),
  ],
});

const CLAUDE_OPUS_5_CAPABILITIES = createModelCapabilities({
  optionDescriptors: [
    buildSelectOptionDescriptor({
      id: "effort",
      label: "Reasoning",
      options: [
        { value: "low", label: "Low" },
        { value: "medium", label: "Medium" },
        { value: "high", label: "High", isDefault: true },
        { value: "xhigh", label: "Extra High" },
        { value: "max", label: "Max" },
        {
          value: "ultracode",
          label: "Ultracode",
          description: "xhigh effort plus multi-agent workflow orchestration",
        },
        { value: "ultrathink", label: "Ultrathink" },
      ],
      promptInjectedValues: ["ultrathink"],
    }),
    buildBooleanOptionDescriptor({
      id: "fastMode",
      label: "Fast Mode",
    }),
    buildSelectOptionDescriptor({
      id: "contextWindow",
      label: "Context Window",
      // Claude Code selects the 1M variant explicitly (`claude-opus-5[1m]`).
      options: [
        { value: "200k", label: "200k" },
        { value: "1m", label: "1M", isDefault: true },
      ],
    }),
  ],
});

export const CLAUDE_MODEL_CATALOG: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "claude-opus-5-5",
    name: "Claude Opus 5.5",
    isCustom: false,
    capabilities: CLAUDE_OPUS_5_CAPABILITIES,
  },
  {
    slug: "claude-fable-5-1",
    name: "Claude Fable 5.1",
    isCustom: false,
    capabilities: CLAUDE_FABLE_5_CAPABILITIES,
  },
  {
    slug: "claude-fable-5",
    name: "Claude Fable 5",
    isCustom: false,
    capabilities: CLAUDE_FABLE_5_CAPABILITIES,
  },
  {
    slug: "claude-opus-5",
    name: "Claude Opus 5",
    isCustom: false,
    capabilities: CLAUDE_OPUS_5_CAPABILITIES,
  },
  {
    slug: "claude-opus-4-8",
    name: "Claude Opus 4.8",
    isCustom: false,
    capabilities: createModelCapabilities({
      optionDescriptors: [
        buildSelectOptionDescriptor({
          id: "effort",
          label: "Reasoning",
          options: [
            { value: "low", label: "Low" },
            { value: "medium", label: "Medium" },
            { value: "high", label: "High", isDefault: true },
            { value: "xhigh", label: "Extra High" },
            { value: "max", label: "Max" },
            {
              value: "ultracode",
              label: "Ultracode",
              description: "xhigh effort plus multi-agent workflow orchestration",
            },
            { value: "ultrathink", label: "Ultrathink" },
          ],
          promptInjectedValues: ["ultrathink"],
        }),
        buildBooleanOptionDescriptor({
          id: "fastMode",
          label: "Fast Mode",
        }),
      ],
    }),
  },
  {
    slug: "claude-opus-4-7",
    name: "Claude Opus 4.7",
    isCustom: false,
    capabilities: createModelCapabilities({
      optionDescriptors: [
        buildSelectOptionDescriptor({
          id: "effort",
          label: "Reasoning",
          options: [
            { value: "low", label: "Low" },
            { value: "medium", label: "Medium" },
            { value: "high", label: "High" },
            { value: "xhigh", label: "Extra High", isDefault: true },
            { value: "max", label: "Max" },
            { value: "ultrathink", label: "Ultrathink" },
          ],
          promptInjectedValues: ["ultrathink"],
        }),
        buildBooleanOptionDescriptor({
          id: "fastMode",
          label: "Fast Mode",
        }),
      ],
    }),
  },
  {
    slug: "claude-opus-4-6",
    name: "Claude Opus 4.6",
    isCustom: false,
    capabilities: createModelCapabilities({
      optionDescriptors: [
        buildSelectOptionDescriptor({
          id: "effort",
          label: "Reasoning",
          options: [
            { value: "low", label: "Low" },
            { value: "medium", label: "Medium" },
            { value: "high", label: "High", isDefault: true },
            { value: "max", label: "Max" },
            { value: "ultrathink", label: "Ultrathink" },
          ],
          promptInjectedValues: ["ultrathink"],
        }),
        buildBooleanOptionDescriptor({
          id: "fastMode",
          label: "Fast Mode",
        }),
        buildSelectOptionDescriptor({
          id: "contextWindow",
          label: "Context Window",
          options: [
            { value: "200k", label: "200k" },
            { value: "1m", label: "1M", isDefault: true },
          ],
        }),
      ],
    }),
  },
  {
    slug: "claude-opus-4-5",
    name: "Claude Opus 4.5",
    isCustom: false,
    capabilities: createModelCapabilities({
      optionDescriptors: [
        buildSelectOptionDescriptor({
          id: "effort",
          label: "Reasoning",
          options: [
            { value: "low", label: "Low" },
            { value: "medium", label: "Medium" },
            { value: "high", label: "High", isDefault: true },
            { value: "max", label: "Max" },
          ],
        }),
        buildBooleanOptionDescriptor({
          id: "fastMode",
          label: "Fast Mode",
        }),
      ],
    }),
  },
  {
    slug: "claude-sonnet-5",
    name: "Claude Sonnet 5",
    isCustom: false,
    capabilities: createModelCapabilities({
      optionDescriptors: [
        buildSelectOptionDescriptor({
          id: "effort",
          label: "Reasoning",
          options: [
            { value: "low", label: "Low" },
            { value: "medium", label: "Medium" },
            { value: "high", label: "High", isDefault: true },
            { value: "xhigh", label: "Extra High" },
            { value: "max", label: "Max" },
            { value: "ultrathink", label: "Ultrathink" },
          ],
          promptInjectedValues: ["ultrathink"],
        }),
        buildSelectOptionDescriptor({
          id: "contextWindow",
          label: "Context Window",
          // Sonnet is 200k-default in Claude Code (1M is opt-in there too).
          options: [
            { value: "200k", label: "200k", isDefault: true },
            { value: "1m", label: "1M" },
          ],
        }),
      ],
    }),
  },
  {
    slug: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    isCustom: false,
    capabilities: createModelCapabilities({
      optionDescriptors: [
        buildSelectOptionDescriptor({
          id: "effort",
          label: "Reasoning",
          options: [
            { value: "low", label: "Low" },
            { value: "medium", label: "Medium" },
            { value: "high", label: "High", isDefault: true },
            { value: "max", label: "Max" },
            { value: "ultrathink", label: "Ultrathink" },
          ],
          promptInjectedValues: ["ultrathink"],
        }),
        buildSelectOptionDescriptor({
          id: "contextWindow",
          label: "Context Window",
          // Sonnet is 200k-default in Claude Code (1M is opt-in there too).
          options: [
            { value: "200k", label: "200k", isDefault: true },
            { value: "1m", label: "1M" },
          ],
        }),
      ],
    }),
  },
  {
    slug: "claude-haiku-4-5",
    name: "Claude Haiku 4.5",
    isCustom: false,
    capabilities: createModelCapabilities({
      optionDescriptors: [
        buildBooleanOptionDescriptor({
          id: "thinking",
          label: "Thinking",
        }),
      ],
    }),
  },
];

// Legacy classification happens at the driver boundary via `applyModelCatalog`,
// so the catalog itself carries no `isLegacy` flags.
export const BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = CLAUDE_MODEL_CATALOG;

export function supportsClaudeOpus5(version: string | null | undefined): boolean {
  return version ? compareSemverVersions(version, MINIMUM_CLAUDE_OPUS_5_VERSION) >= 0 : false;
}

export function supportsClaudeFable5(version: string | null | undefined): boolean {
  return version ? compareSemverVersions(version, MINIMUM_CLAUDE_FABLE_5_VERSION) >= 0 : false;
}

export function supportsClaudeOpus48(version: string | null | undefined): boolean {
  return version ? compareSemverVersions(version, MINIMUM_CLAUDE_OPUS_4_8_VERSION) >= 0 : false;
}

export function supportsClaudeOpus47(version: string | null | undefined): boolean {
  return version ? compareSemverVersions(version, MINIMUM_CLAUDE_OPUS_4_7_VERSION) >= 0 : false;
}

export function getBuiltInClaudeModelsForVersion(
  version: string | null | undefined,
): ReadonlyArray<ServerProviderModel> {
  return BUILT_IN_MODELS.filter((model) => {
    if (model.slug === "claude-opus-5" || model.slug === "claude-opus-5-5") {
      return supportsClaudeOpus5(version);
    }

    if (model.slug === "claude-fable-5" || model.slug === "claude-fable-5-1") {
      return supportsClaudeFable5(version);
    }

    if (model.slug === "claude-opus-4-8") {
      return supportsClaudeOpus48(version);
    }

    if (model.slug === "claude-opus-4-7") {
      return supportsClaudeOpus47(version);
    }

    return true;
  });
}

export function formatClaudeOpus5UpgradeMessage(version: string | null): string {
  const versionLabel = version ? `v${version}` : "the installed version";

  return `Claude Code ${versionLabel} is too old for Claude Opus 5. Upgrade to v${MINIMUM_CLAUDE_OPUS_5_VERSION} or newer to access it.`;
}

export function formatClaudeFable5UpgradeMessage(version: string | null): string {
  const versionLabel = version ? `v${version}` : "the installed version";

  return `Claude Code ${versionLabel} is too old for Claude Fable 5. Upgrade to v${MINIMUM_CLAUDE_FABLE_5_VERSION} or newer to access it.`;
}

export function formatClaudeOpus48UpgradeMessage(version: string | null): string {
  const versionLabel = version ? `v${version}` : "the installed version";

  return `Claude Code ${versionLabel} is too old for Claude Opus 4.8. Upgrade to v${MINIMUM_CLAUDE_OPUS_4_8_VERSION} or newer to access it.`;
}

export function formatClaudeOpus47UpgradeMessage(version: string | null): string {
  const versionLabel = version ? `v${version}` : "the installed version";

  return `Claude Code ${versionLabel} is too old for Claude Opus 4.7. Upgrade to v${MINIMUM_CLAUDE_OPUS_4_7_VERSION} or newer to access it.`;
}

/** `claude-sonnet-5-5` → `claude-sonnet`. */
const claudeModelFamily = (slug: string) => slug.replace(/(-\d+)+$/, "");

/**
 * Built-in model a Claude slug behaves like. A model released after this build
 * (listed by the models.dev catalog but not here) maps to the newest built-in
 * model of its family, so new releases keep their reasoning controls.
 */
function builtInClaudeModel(model: string | null | undefined) {
  const slug = model?.trim() ?? "";
  const family = claudeModelFamily(slug);

  return (
    BUILT_IN_MODELS.find((candidate) => candidate.slug === slug) ??
    (slug.startsWith("claude-") && family !== slug
      ? BUILT_IN_MODELS.find((candidate) => claudeModelFamily(candidate.slug) === family)
      : undefined)
  );
}

export function getClaudeModelCapabilities(model: string | null | undefined): ModelCapabilities {
  return builtInClaudeModel(model)?.capabilities ?? DEFAULT_CLAUDE_MODEL_CAPABILITIES;
}

export function resolveClaudeEffort(
  caps: ModelCapabilities,
  raw: string | null | undefined,
): string | undefined {
  const descriptors = getProviderOptionDescriptors({
    caps,
    ...(raw ? { selections: [{ id: "effort", value: raw }] } : {}),
  });

  const effortDescriptor = descriptors.find((descriptor) => descriptor.id === "effort");
  const value = getProviderOptionCurrentValue(effortDescriptor);

  return Predicate.isString(value) ? value : undefined;
}

/**
 * Normalize a resolved Claude effort value into one suitable for the Claude
 * CLI's `--effort` flag.
 *
 * Mirrors the mapping used when invoking the Claude Agent SDK
 * ({@link getEffectiveClaudeAgentEffort} in ClaudeAdapter): `ultracode` is a
 * Claude Code setting that pairs with `xhigh`, `ultrathink` is filtered out
 * because it is a prompt-prefix mode, and older model compatibility mappings
 * are preserved for current Claude Code behavior.
 */
export function normalizeClaudeCliEffort(
  effort: string | null | undefined,
  model: string | null | undefined,
): string | undefined {
  if (!effort || effort === "ultrathink") {
    return undefined;
  }

  if (effort === "ultracode") {
    return "xhigh";
  }

  const slug = builtInClaudeModel(model)?.slug ?? model;

  if (
    effort === "xhigh" &&
    slug !== "claude-fable-5-1" &&
    slug !== "claude-fable-5" &&
    slug !== "claude-opus-5-5" &&
    slug !== "claude-opus-5" &&
    slug !== "claude-opus-4-8" &&
    slug !== "claude-sonnet-5"
  ) {
    return "max";
  }

  if (effort === "max" && slug === "claude-sonnet-4-6") {
    return "high";
  }

  return effort;
}

export function isClaudeUltracodeEffort(effort: string | null | undefined): boolean {
  return effort === "ultracode";
}

export function resolveClaudeContextWindow(
  modelSelection: ModelSelection | undefined,
): string | undefined {
  const caps = getClaudeModelCapabilities(modelSelection?.model);
  const raw = getModelSelectionStringOptionValue(modelSelection, "contextWindow");

  const descriptors = getProviderOptionDescriptors({
    caps,
    ...(raw ? { selections: [{ id: "contextWindow", value: raw }] } : {}),
  });

  const descriptor = descriptors.find((candidate) => candidate.id === "contextWindow");
  const value = getProviderOptionCurrentValue(descriptor);

  return Predicate.isString(value) ? value : undefined;
}

export function resolveClaudeApiModelId(modelSelection: ModelSelection): string {
  switch (resolveClaudeContextWindow(modelSelection)) {
    case "1m":
      return `${modelSelection.model}[1m]`;
    default:
      return modelSelection.model;
  }
}
