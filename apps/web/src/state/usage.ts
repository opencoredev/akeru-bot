import * as Schema from "effect/Schema";
import { hasTag } from "~/lib/taggedUnion";
import {
  aggregateUsage,
  usageWindowKey,
  type EnvironmentUsageStatus,
} from "@akeru/client-runtime/usage";
/**
 * Multi-environment usage state.
 *
 * Every connected environment answers the same typed query; the client merges
 * the results. Raw transcripts never leave the machine that produced them.
 *
 * @module state/usage
 */
import { useAtomValue } from "@effect/atom-react";
import { UsageSummaryInput } from "@akeru/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback, useMemo } from "react";

import { makeWindow } from "@akeru/shared/usageFormat";
import type { MergedUsage } from "@akeru/shared/usageMerge";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentPresentations } from "./presentation";
import { serverEnvironment } from "./server";

export const USAGE_LOOKBACK_DAYS = 30;

const decodeUsageWindow = Schema.decodeUnknownSync(UsageSummaryInput);

/**
 * Reads every environment's summary for one window.
 *
 * Keyed by the serialised window so switching ranges does not thrash the atom
 * cache, and so each environment's query is shared with any other reader of the
 * same window.
 */
const usageByWindowAtom = Atom.family((windowKey: string) =>
  Atom.make((get): readonly EnvironmentUsageStatus[] => {
    const input = decodeUsageWindow(JSON.parse(windowKey));
    const presentations = get(environmentPresentations.presentationsAtom);

    const statuses: EnvironmentUsageStatus[] = [];

    for (const [environmentId, presentation] of presentations) {
      const result = get(serverEnvironment.usageSummary({ environmentId, input }));
      statuses.push({
        environmentId,
        label: presentation.entry.target.label,
        isPending: result.waiting,
        error: hasTag(result, "Failure") ? "This environment could not report usage." : null,
        summary: Option.getOrNull(AsyncResult.value(result)),
      });
    }

    return statuses;
  }).pipe(Atom.withLabel(`web-usage:window:${windowKey}`)),
);

export interface UsageView {
  readonly merged: MergedUsage;
  readonly environments: readonly EnvironmentUsageStatus[];
  /** True until at least one environment has answered. */
  readonly isPending: boolean;
  /**
   * True while environments that have not failed are still answering. Failed
   * environments are reported through their own error rows: totals will not
   * improve by waiting on them, so they must not read as "still reporting".
   */
  readonly isPartial: boolean;
  readonly refresh: () => void;
}

export function useUsage(input: UsageSummaryInput = makeWindow(USAGE_LOOKBACK_DAYS)): UsageView {
  const windowKey = useMemo(
    () => usageWindowKey(input),
    [
      input.sinceDay,
      input.untilDay,
      input.timeZone,
      input.resolution,
      input.sinceTime,
      input.untilTime,
    ],
  );

  const atom = usageByWindowAtom(windowKey);
  const environments = useAtomValue(atom);

  // Refreshing only the derived atom would re-read the per-environment SWR
  // queries within their stale window and change nothing. Refresh each
  // environment's query so the button always rescans.
  const refresh = useCallback(() => {
    const input = decodeUsageWindow(JSON.parse(windowKey));

    for (const environment of environments) {
      appAtomRegistry.refresh(
        serverEnvironment.usageSummary({ environmentId: environment.environmentId, input }),
      );
    }
  }, [environments, windowKey]);

  const usage = useMemo(() => aggregateUsage(environments), [environments]);

  return {
    ...usage,
    environments,
    refresh,
  };
}
