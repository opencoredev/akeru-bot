import { useAtomValue } from "@effect/atom-react";
import { DEFAULT_SERVER_SETTINGS, type EnvironmentId } from "@t3tools/contracts";

import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { ImageGenerationSummaryView } from "./ImageGenerationSummaryView";

export function ImageGenerationSummary({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const settings =
    useAtomValue(serverEnvironment.settingsValueAtom(environmentId))?.imageGeneration ??
    DEFAULT_SERVER_SETTINGS.imageGeneration;
  const query = useEnvironmentQuery(serverEnvironment.imageProviders({ environmentId, input: {} }));
  return <ImageGenerationSummaryView settings={settings} query={query} onRetry={query.refresh} />;
}
