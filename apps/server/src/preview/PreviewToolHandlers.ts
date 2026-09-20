import {
  PreviewAutomationClickInput,
  PreviewAutomationEvaluateInput,
  PreviewAutomationNavigateInput,
  PreviewAutomationOpenInput,
  PreviewAutomationPressInput,
  PreviewAutomationResizeInput,
  PreviewAutomationScrollInput,
  PreviewAutomationSetColorSchemeInput,
  PreviewAutomationTabTargetInput,
  PreviewAutomationTypeInput,
  PreviewAutomationWaitForInput,
  type PreviewAutomationOperation,
  type PreviewAutomationOpenInput as PreviewAutomationOpenInputValue,
  type PreviewTabId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import type { AkeruToolExecution } from "../provider/AkeruToolRuntime.ts";

export const AKERU_PREVIEW_TOOL_IDS = [
  "preview_status",
  "preview_open",
  "preview_navigate",
  "preview_resize",
  "preview_set_appearance",
  "preview_snapshot",
  "preview_click",
  "preview_type",
  "preview_press",
  "preview_scroll",
  "preview_evaluate",
  "preview_wait_for",
  "preview_recording_start",
  "preview_recording_stop",
] as const;

export type AkeruPreviewToolId = (typeof AKERU_PREVIEW_TOOL_IDS)[number];

export const AkeruPreviewToolInputSchemas = {
  preview_status: PreviewAutomationTabTargetInput,
  preview_open: PreviewAutomationOpenInput,
  preview_navigate: PreviewAutomationNavigateInput,
  preview_resize: PreviewAutomationResizeInput,
  preview_set_appearance: PreviewAutomationSetColorSchemeInput,
  preview_snapshot: Schema.Struct({
    ...PreviewAutomationTabTargetInput.fields,
    includeImage: Schema.optional(
      Schema.Boolean.annotate({
        description:
          "Include the PNG image in the tool response. Defaults to true. Set false for text-only output.",
      }),
    ),
  }),
  preview_click: PreviewAutomationClickInput,
  preview_type: PreviewAutomationTypeInput,
  preview_press: PreviewAutomationPressInput,
  preview_scroll: PreviewAutomationScrollInput,
  preview_evaluate: PreviewAutomationEvaluateInput,
  preview_wait_for: PreviewAutomationWaitForInput,
  preview_recording_start: PreviewAutomationTabTargetInput,
  preview_recording_stop: PreviewAutomationTabTargetInput,
} as const satisfies Record<AkeruPreviewToolId, Schema.Top>;

export const PREVIEW_TOOL_DESCRIPTIONS = {
  preview_status:
    "Report whether a collaborative browser tab is automation-capable, including its URL, title, visibility, loading state, viewport mode, and measured CSS-pixel size. Pass tabId to inspect a specific tab; omit it to use this agent session's current tab.",
  preview_open:
    "Initialize a collaborative browser tab and open its thread-bound inline preview by default. Set open=false for background-only automation. Pass tabId to reuse a specific existing tab, set reuseExistingTab=false to create another tab, or omit both to use this agent session's current tab.",
  preview_navigate:
    "Navigate a collaborative browser tab. Pass tabId to target a specific tab, plus {url:'https://example.com'} for a website or {target:{kind:'environment-port',port:5173}} for a dev server. Exactly one of url or target is required.",
  preview_resize:
    "Resize a collaborative browser tab, optionally selected by tabId. Use {mode:'fill'}, {mode:'freeform',width:1024,height:768}, or {mode:'preset',preset:'iphone-12-pro',orientation:'portrait'}. This changes CSS layout breakpoints without changing the desktop browser user agent.",
  preview_set_appearance:
    "Emulate prefers-color-scheme in a collaborative browser tab, optionally selected by tabId. Use {colorScheme:'dark'} or {colorScheme:'light'} to preview the page in that appearance, and {colorScheme:'system'} to clear the override and follow the OS appearance.",
  preview_snapshot:
    "Inspect a page before interacting. Pass tabId to inspect a specific tab; omit it to use this agent session's current tab. Returns page state, semantic elements, diagnostics, action history, and a PNG screenshot. Set includeImage=false for text-only output with the same page metadata.",
  preview_click:
    "Click exactly one target in the tab selected by tabId, or this agent session's current tab when omitted. Prefer a Playwright locator; selector accepts legacy CSS; x and y must be supplied together.",
  preview_type:
    "Insert literal text into one input in the tab selected by tabId, or this agent session's current tab when omitted. Prefer a Playwright locator; set clear=true to replace existing text.",
  preview_press:
    "Press one keyboard key in the tab selected by tabId, or this agent session's current tab when omitted. Examples: {key:'Enter'}, {key:'Escape'}, or {key:'a',modifiers:['Meta']}.",
  preview_scroll:
    "Scroll the tab selected by tabId, or this agent session's current tab when omitted. Positive deltaY scrolls down and positive deltaX scrolls right; a locator/selector targets a container.",
  preview_evaluate:
    "Evaluate JavaScript in the tab selected by tabId, or this agent session's current tab when omitted. Returns a serializable result up to 64 KB; the expression may mutate page state.",
  preview_wait_for:
    "Wait in the tab selected by tabId, or this agent session's current tab when omitted, until all supplied locator, selector, text, and URL conditions match.",
  preview_recording_start:
    "Start recording the collaborative browser tab selected by tabId, or this agent session's current tab when omitted.",
  preview_recording_stop:
    "Stop recording the collaborative browser tab selected by tabId, or this agent session's current tab when omitted, and save it as a local evidence artifact.",
} as const satisfies Record<AkeruPreviewToolId, string>;

export const PREVIEW_TOOL_DEFINITIONS = AKERU_PREVIEW_TOOL_IDS.map((id) => ({
  id,
  description: PREVIEW_TOOL_DESCRIPTIONS[id],
}));

const EMPTY_RESULT_TOOLS = new Set<AkeruPreviewToolId>([
  "preview_click",
  "preview_type",
  "preview_press",
  "preview_scroll",
  "preview_wait_for",
]);

export function isPreviewToolId(toolId: string): toolId is AkeruPreviewToolId {
  return (AKERU_PREVIEW_TOOL_IDS as readonly string[]).includes(toolId);
}

/**
 * Collapses the `show` alias onto `open` and defaults tab reuse.
 *
 * Deliberately leaves an unstated `open` unstated. Whether a preview the agent
 * said nothing about surfaces is the user's `browserAutoShowFloatingPreview`
 * preference, which is desktop-local and unreadable from here — filling in
 * `true` would silently override it for every `preview_open`.
 */
export function normalizePreviewOpenInput(
  input: PreviewAutomationOpenInputValue,
): PreviewAutomationOpenInputValue {
  const open = input.open ?? input.show;
  return {
    ...input,
    ...(open === undefined ? {} : { open, show: open }),
    reuseExistingTab: input.reuseExistingTab ?? true,
  };
}

export interface PreviewToolInvocation {
  readonly operation: PreviewAutomationOperation;
  readonly input: unknown;
  readonly timeoutMs?: number;
  readonly tabId?: PreviewTabId;
  readonly emptyResult: boolean;
  readonly nullishEvaluate: boolean;
}

const PREVIEW_TOOL_OPERATIONS = {
  preview_status: "status",
  preview_open: "open",
  preview_navigate: "navigate",
  preview_resize: "resize",
  preview_set_appearance: "setColorScheme",
  preview_snapshot: "snapshot",
  preview_click: "click",
  preview_type: "type",
  preview_press: "press",
  preview_scroll: "scroll",
  preview_evaluate: "evaluate",
  preview_wait_for: "waitFor",
  preview_recording_start: "recordingStart",
  preview_recording_stop: "recordingStop",
} as const satisfies Record<AkeruPreviewToolId, PreviewAutomationOperation>;

function field(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  return Object.getOwnPropertyDescriptor(value, key)?.value;
}

export function preparePreviewToolInvocation(
  toolId: AkeruPreviewToolId,
  input: unknown,
): PreviewToolInvocation {
  const raw = typeof input === "object" && input !== null ? input : {};
  const normalized =
    toolId === "preview_open"
      ? normalizePreviewOpenInput(raw as PreviewAutomationOpenInputValue)
      : raw;
  const tabId = field(normalized, "tabId");
  const timeoutMs = field(normalized, "timeoutMs");
  const { tabId: _tabId, includeImage: _includeImage, ...operationInput } = normalized as Record<
    string,
    unknown
  >;
  return {
    operation: PREVIEW_TOOL_OPERATIONS[toolId],
    input: operationInput,
    ...(typeof timeoutMs === "number" ? { timeoutMs } : {}),
    ...(typeof tabId === "string" ? { tabId: tabId as PreviewTabId } : {}),
    emptyResult: EMPTY_RESULT_TOOLS.has(toolId),
    nullishEvaluate: toolId === "preview_evaluate",
  };
}

export type AkeruPreviewToolHandler = (
  input: Omit<AkeruToolExecution, "toolId"> & { readonly toolId: AkeruPreviewToolId },
) => Promise<unknown>;

export type PreviewOperationInvoker = (input: {
  readonly operation: PreviewAutomationOperation;
  readonly input: unknown;
  readonly timeoutMs?: number;
  readonly tabId?: PreviewTabId;
}) => Promise<unknown>;

export function createPreviewToolHandlers(
  invoke: PreviewOperationInvoker,
): Record<AkeruPreviewToolId, AkeruPreviewToolHandler> {
  return Object.fromEntries(
    AKERU_PREVIEW_TOOL_IDS.map((toolId) => [
      toolId,
      async ({ input }: { readonly input: unknown }) => {
        const invocation = preparePreviewToolInvocation(toolId, input);
        const result = await invoke({
          operation: invocation.operation,
          input: invocation.input,
          ...(invocation.timeoutMs === undefined ? {} : { timeoutMs: invocation.timeoutMs }),
          ...(invocation.tabId === undefined ? {} : { tabId: invocation.tabId }),
        });
        if (invocation.emptyResult) return {};
        if (invocation.nullishEvaluate) return result ?? null;
        return result;
      },
    ]),
  ) as Record<AkeruPreviewToolId, AkeruPreviewToolHandler>;
}
