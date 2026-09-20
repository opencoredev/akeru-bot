import * as Effect from "effect/Effect";
import type {
  PreviewAutomationOperation,
  PreviewAutomationRecordingArtifact,
  PreviewAutomationRecordingStatus,
  PreviewAutomationResizeResult,
  PreviewAutomationSetColorSchemeResult,
  PreviewAutomationSnapshot,
  PreviewAutomationStatus,
  PreviewTabId,
} from "@t3tools/contracts";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";
import {
  normalizePreviewOpenInput,
  preparePreviewToolInvocation,
  type AkeruPreviewToolId,
} from "../../../preview/PreviewToolHandlers.ts";
import { PreviewSnapshotToolkit, PreviewStandardToolkit, PreviewToolkit } from "./tools.ts";

export { normalizePreviewOpenInput };

const invoke = Effect.fn("PreviewToolkit.invoke")(function* <A>(
  operation: PreviewAutomationOperation,
  input: unknown,
  timeoutMs?: number,
  tabId?: PreviewTabId,
): Effect.fn.Return<
  A,
  import("@t3tools/contracts").PreviewAutomationError,
  McpInvocationContext.McpInvocationContext | PreviewAutomationBroker.PreviewAutomationBroker
> {
  const scope = yield* McpInvocationContext.requireMcpCapability("preview");
  const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
  return yield* broker.invoke<A>({
    scope,
    operation,
    input,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(tabId === undefined ? {} : { tabId }),
  });
});

const invokePreviewTool = <A>(toolId: AkeruPreviewToolId, input: unknown) => {
  const invocation = preparePreviewToolInvocation(toolId, input ?? {});
  return invoke<A>(
    invocation.operation,
    invocation.input,
    invocation.timeoutMs,
    invocation.tabId,
  ).pipe(
    Effect.map((result) => {
      if (invocation.emptyResult) return {} as A;
      if (invocation.nullishEvaluate) return (result ?? null) as A;
      return result;
    }),
  );
};

const handlers = {
  preview_status: (input) => invokePreviewTool<PreviewAutomationStatus>("preview_status", input),
  preview_open: (input) => invokePreviewTool<PreviewAutomationStatus>("preview_open", input),
  preview_navigate: (input) => invokePreviewTool<PreviewAutomationStatus>("preview_navigate", input),
  preview_resize: (input) => invokePreviewTool<PreviewAutomationResizeResult>("preview_resize", input),
  preview_set_appearance: (input) =>
    invokePreviewTool<PreviewAutomationSetColorSchemeResult>("preview_set_appearance", input),
  preview_snapshot: (input) =>
    invokePreviewTool<PreviewAutomationSnapshot>("preview_snapshot", input),
  preview_click: (input) => invokePreviewTool<Record<string, never>>("preview_click", input),
  preview_type: (input) => invokePreviewTool<Record<string, never>>("preview_type", input),
  preview_press: (input) => invokePreviewTool<Record<string, never>>("preview_press", input),
  preview_scroll: (input) => invokePreviewTool<Record<string, never>>("preview_scroll", input),
  preview_evaluate: (input) => invokePreviewTool<unknown>("preview_evaluate", input),
  preview_wait_for: (input) => invokePreviewTool<Record<string, never>>("preview_wait_for", input),
  preview_recording_start: (input) =>
    invokePreviewTool<PreviewAutomationRecordingStatus>("preview_recording_start", input),
  preview_recording_stop: (input) =>
    invokePreviewTool<PreviewAutomationRecordingArtifact>("preview_recording_stop", input),
} satisfies Parameters<typeof PreviewToolkit.toLayer>[0];

const { preview_snapshot, ...standardHandlers } = handlers;

export const PreviewStandardToolkitHandlersLive = PreviewStandardToolkit.toLayer(standardHandlers);

export const PreviewSnapshotToolkitHandlersLive = PreviewSnapshotToolkit.toLayer({
  preview_snapshot,
});

export const PreviewToolkitHandlersLive = PreviewToolkit.toLayer(handlers);
