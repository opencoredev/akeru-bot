import { Schema } from "effect";
import { PreviewTabId } from "../preview.ts";

export const PreviewAutomationRecordingStatus = Schema.Struct({
  tabId: PreviewTabId,
  recording: Schema.Boolean,
  startedAt: Schema.NullOr(Schema.String),
});

export type PreviewAutomationRecordingStatus = typeof PreviewAutomationRecordingStatus.Type;

export const PreviewAutomationRecordingArtifact = Schema.Struct({
  id: Schema.String,
  tabId: PreviewTabId,
  path: Schema.String,
  mimeType: Schema.String,
  sizeBytes: Schema.Int,
  createdAt: Schema.String,
});

export type PreviewAutomationRecordingArtifact = typeof PreviewAutomationRecordingArtifact.Type;
