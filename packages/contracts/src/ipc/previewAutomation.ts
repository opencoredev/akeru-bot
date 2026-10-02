import * as Schema from "effect/Schema";
import {
  PreviewAutomationClickInput,
  PreviewAutomationEvaluateInput,
  PreviewAutomationPressInput,
  PreviewAutomationScrollInput,
  PreviewAutomationTypeInput,
  PreviewAutomationWaitForInput,
} from "../previewAutomation/input.ts";
import { EnvironmentId } from "../baseSchemas.ts";
import {
  type DesktopPreviewColorScheme,
  DesktopPreviewColorSchemeSchema,
  DesktopPreviewTabIdSchema,
  DesktopPreviewAnnotationThemeSchema,
} from "./preview.ts";

export const DesktopPreviewTabInputSchema = Schema.Struct({
  tabId: DesktopPreviewTabIdSchema,
});

/**
 * Tab creation carries the client's configured browser defaults so the guest
 * is born already zoomed and color-scheme-emulated. Applying them after
 * creation instead would paint one frame at 100%/system first, which reads as
 * a flash on every tab open. Both fields are optional so an older renderer
 * still gets the historical defaults.
 */
export const DesktopPreviewCreateTabInputSchema = Schema.Struct({
  tabId: DesktopPreviewTabIdSchema,
  zoomFactor: Schema.optional(Schema.Number.check(Schema.isGreaterThan(0))),
  colorScheme: Schema.optional(DesktopPreviewColorSchemeSchema),
});

export interface DesktopPreviewTabDefaults {
  readonly zoomFactor?: number | undefined;
  readonly colorScheme?: DesktopPreviewColorScheme | undefined;
}

export const DesktopPreviewRegisterWebviewInputSchema = Schema.Struct({
  tabId: DesktopPreviewTabIdSchema,
  webContentsId: Schema.Int.check(Schema.isGreaterThan(0)),
});

export const DesktopPreviewNavigateInputSchema = Schema.Struct({
  tabId: DesktopPreviewTabIdSchema,
  url: Schema.String,
});

export const DesktopPreviewConfigInputSchema = Schema.Struct({
  environmentId: EnvironmentId,
});

export const DesktopPreviewSetColorSchemeInputSchema = Schema.Struct({
  tabId: DesktopPreviewTabIdSchema,
  colorScheme: DesktopPreviewColorSchemeSchema,
});

export const DesktopPreviewSetAudioMutedInputSchema = Schema.Struct({
  tabId: DesktopPreviewTabIdSchema,
  audioMuted: Schema.Boolean,
});

export const DesktopPreviewAnnotationThemeInputSchema = Schema.Struct({
  theme: DesktopPreviewAnnotationThemeSchema,
});

export const DesktopPreviewArtifactInputSchema = Schema.Struct({
  path: Schema.String.check(Schema.isTrimmed()).check(Schema.isNonEmpty()),
});

export const DesktopPreviewRecordingSaveInputSchema = Schema.Struct({
  tabId: DesktopPreviewTabIdSchema,
  mimeType: Schema.String.check(Schema.isTrimmed()).check(Schema.isNonEmpty()),
  data: Schema.Uint8Array,
});

export const DesktopPreviewAutomationClickInputSchema = Schema.Struct({
  tabId: DesktopPreviewTabIdSchema,
  input: PreviewAutomationClickInput,
});

export const DesktopPreviewAutomationTypeInputSchema = Schema.Struct({
  tabId: DesktopPreviewTabIdSchema,
  input: PreviewAutomationTypeInput,
});

export const DesktopPreviewAutomationPressInputSchema = Schema.Struct({
  tabId: DesktopPreviewTabIdSchema,
  input: PreviewAutomationPressInput,
});

export const DesktopPreviewAutomationScrollInputSchema = Schema.Struct({
  tabId: DesktopPreviewTabIdSchema,
  input: PreviewAutomationScrollInput,
});

export const DesktopPreviewAutomationEvaluateInputSchema = Schema.Struct({
  tabId: DesktopPreviewTabIdSchema,
  input: PreviewAutomationEvaluateInput,
});

export const DesktopPreviewAutomationWaitForInputSchema = Schema.Struct({
  tabId: DesktopPreviewTabIdSchema,
  input: PreviewAutomationWaitForInput,
});
