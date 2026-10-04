import { createModelCapabilities } from "@akeru/shared/model";
import { ProviderDriverKind } from "@akeru/contracts";
import { CLAUDE_MODEL_CATALOG, getClaudeModelCapabilities } from "./Layers/claude/ClaudeModels.ts";
import { reasoningCapabilities } from "./ReasoningOptions.ts";
import { BUNDLED_MODEL_CATALOG, catalogModelsFor, type CatalogModel } from "./modelCatalogData.ts";

/** The subscription transport advertises native controls, without CLI workflow choices. */
export function claudeHarnessCapabilities(slug: string, entry: CatalogModel | undefined) {
  const previous = getClaudeModelCapabilities(slug);

  const builtIn = CLAUDE_MODEL_CATALOG.find((model) => model.slug === slug);

  const builtInEffort = builtIn?.capabilities?.optionDescriptors?.find(
    (descriptor) => descriptor.id === "effort" && descriptor.type === "select",
  );

  const fallback =
    builtInEffort?.type === "select"
      ? { id: slug, name: slug, efforts: builtInEffort.options.map((option) => option.id) }
      : undefined;

  const driver = ProviderDriverKind.make("claudeAgent");

  const bundled = catalogModelsFor(BUNDLED_MODEL_CATALOG, driver).find(
    (model) => model.id === slug,
  );

  const native = reasoningCapabilities(driver, slug, entry ?? bundled ?? fallback);

  return createModelCapabilities({
    optionDescriptors: [
      ...(native.optionDescriptors ?? []),
      ...(previous.optionDescriptors ?? []).filter(
        (descriptor) => descriptor.id === "contextWindow" || descriptor.id === "thinking",
      ),
    ],
  });
}
