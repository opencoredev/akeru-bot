import { Schema } from "effect";
import { TrimmedNonEmptyString } from "../baseSchemas.ts";
import { PreviewRenderedViewportSize, PreviewTabId, PreviewViewportSetting } from "../preview.ts";

export const BoundedUrl = Schema.String.check(Schema.isTrimmed())
  .check(Schema.isNonEmpty())
  .check(Schema.isMaxLength(2048));

export const URL_GUIDANCE =
  "Absolute http(s) URL or a schemeless host such as example.com or localhost:5173. Schemeless public hosts use https; loopback hosts use http.";

export const OptionalTimeoutMs = Schema.optional(
  Schema.Int.check(Schema.isGreaterThan(0))
    .check(Schema.isLessThanOrEqualTo(60_000))
    .annotate({ description: "Maximum wait in milliseconds. Defaults to 15000; maximum 60000." }),
).annotate({ description: "Maximum wait in milliseconds. Defaults to 15000; maximum 60000." });

/** Operations understood by desktop hosts predating viewport resizing. */
export const PREVIEW_AUTOMATION_V1_OPERATIONS = [
  "status",
  "open",
  "navigate",
  "snapshot",
  "click",
  "type",
  "press",
  "scroll",
  "evaluate",
  "waitFor",
  "recordingStart",
  "recordingStop",
] as const;

/** Advertised by current desktop hosts for mixed-version routing. */
export const PREVIEW_AUTOMATION_OPERATIONS = [
  ...PREVIEW_AUTOMATION_V1_OPERATIONS,
  "resize",
  "setColorScheme",
] as const;

export const PreviewAutomationOperation = Schema.Literals(PREVIEW_AUTOMATION_OPERATIONS);

export type PreviewAutomationOperation = typeof PreviewAutomationOperation.Type;

export const PreviewAutomationTabTargetFields = {
  tabId: Schema.optional(
    PreviewTabId.annotate({
      description:
        "Exact collaborative browser tab to target. Omit to use this agent session's current tab.",
    }),
  ).annotate({
    description:
      "Exact collaborative browser tab to target. Omit to use this agent session's current tab.",
  }),
};

export const PreviewAutomationTabTargetInput = Schema.Struct(PreviewAutomationTabTargetFields);

export type PreviewAutomationTabTargetInput = typeof PreviewAutomationTabTargetInput.Type;

export const PreviewAutomationStatus = Schema.Struct({
  available: Schema.Boolean,
  visible: Schema.Boolean,
  tabId: Schema.NullOr(PreviewTabId),
  url: Schema.NullOr(Schema.String),
  title: Schema.NullOr(Schema.String),
  loading: Schema.Boolean,
  /** Optional for compatibility with desktop hosts predating viewport sizing. */
  viewportSetting: Schema.optional(PreviewViewportSetting),
  /** Measured guest-page viewport in CSS pixels when a webview is ready. */
  viewport: Schema.optional(PreviewRenderedViewportSize),
});

export type PreviewAutomationStatus = typeof PreviewAutomationStatus.Type;

export const BrowserNavigationTarget = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("url").annotate({
      description: "Selects direct URL navigation.",
    }),
    url: BoundedUrl.annotate({
      description: `Direct website URL. ${URL_GUIDANCE}`,
    }),
  }),
  Schema.Struct({
    kind: Schema.Literal("environment-port").annotate({
      description: "Selects a dev-server port relative to the current execution environment.",
    }),
    port: Schema.Int.check(Schema.isGreaterThan(0))
      .check(Schema.isLessThan(65_536))
      .annotate({ description: "Dev-server TCP port inside the current environment." }),
    protocol: Schema.optional(
      Schema.Literals(["http", "https"]).annotate({
        description: "Dev-server protocol. Defaults to http.",
      }),
    ),
    path: Schema.optional(
      Schema.String.annotate({
        description: "Optional path, query, and fragment, for example /settings?tab=account.",
      }),
    ),
  }),
]);

export type BrowserNavigationTarget = typeof BrowserNavigationTarget.Type;

/** Mirrors DesktopPreviewColorScheme; declared here to keep this module free of ipc.ts imports. */
export const PreviewAutomationColorScheme = Schema.Literals(["system", "light", "dark"]);

export type PreviewAutomationColorScheme = typeof PreviewAutomationColorScheme.Type;

export const PreviewAutomationClientId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));

export type PreviewAutomationClientId = typeof PreviewAutomationClientId.Type;

export const PreviewAutomationConnectionId = TrimmedNonEmptyString.check(Schema.isMaxLength(64));

export type PreviewAutomationConnectionId = typeof PreviewAutomationConnectionId.Type;
