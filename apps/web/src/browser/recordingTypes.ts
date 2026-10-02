import type { DesktopPreviewRecordingArtifact, ScopedThreadRef } from "@akeru/contracts";
import * as Schema from "effect/Schema";

export class BrowserRecordingUnavailableError extends Schema.TaggedErrorClass<BrowserRecordingUnavailableError>()(
  "BrowserRecordingUnavailableError",
  {
    tabId: Schema.String,
  },
) {
  override get message(): string {
    return `Browser recording is unavailable for tab ${this.tabId}.`;
  }
}

export class BrowserRecordingConflictError extends Schema.TaggedErrorClass<BrowserRecordingConflictError>()(
  "BrowserRecordingConflictError",
  {
    requestedTabId: Schema.String,
    activeTabId: Schema.String,
  },
) {
  override get message(): string {
    return `Cannot record tab ${this.requestedTabId} while tab ${this.activeTabId} is already being recorded.`;
  }
}

export class BrowserRecordingCanvasUnavailableError extends Schema.TaggedErrorClass<BrowserRecordingCanvasUnavailableError>()(
  "BrowserRecordingCanvasUnavailableError",
  {
    tabId: Schema.String,
    width: Schema.Number,
    height: Schema.Number,
  },
) {
  override get message(): string {
    return `Browser recording canvas ${this.width}x${this.height} is unavailable for tab ${this.tabId}.`;
  }
}

export class BrowserRecordingOperationError extends Schema.TaggedErrorClass<BrowserRecordingOperationError>()(
  "BrowserRecordingOperationError",
  {
    operation: Schema.Literals([
      "initialize-media-recorder",
      "subscribe-frames",
      "start-media-recorder",
      "start-screencast",
      "stop-screencast",
      "wait-first-frame",
      "wait-startup",
      "stop-media-recorder",
      "save-artifact",
      "cleanup",
    ]),
    tabId: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Browser recording operation ${this.operation} failed for tab ${this.tabId}.`;
  }
}

export const isBrowserRecordingOperationError = Schema.is(BrowserRecordingOperationError);

type BrowserRecordingLifecycle =
  | { readonly phase: "starting" }
  | { readonly phase: "recording" }
  | {
      readonly phase: "stopping";
      readonly stopPromise: Promise<DesktopPreviewRecordingArtifact | null>;
    };

export interface ActiveRecording {
  /** Desktop-scoped identity used by capture and surface stores. */
  readonly tabId: string;
  /** Server-local identity returned by preview automation tools. */
  readonly serverTabId: string;
  readonly threadRef: ScopedThreadRef | null;
  readonly canvas: HTMLCanvasElement;
  readonly context: CanvasRenderingContext2D;
  readonly chunks: Blob[];
  readonly startedAt: string;
  readonly startupSettled: Promise<void>;
  readonly firstFrameSize: Promise<"frame" | "cancelled">;
  readonly settleFirstFrameSize: (outcome: "frame" | "cancelled") => void;
  recorder: MediaRecorder | null;
  mimeType: string | null;
  frameSizeEstablished: boolean;
  frameSequence: number;
  lastDrawnFrameSequence: number;
  lifecycle: BrowserRecordingLifecycle;
}

export interface ActiveBrowserRecordingTarget {
  readonly runtimeTabId: string;
  readonly serverTabId: string;
}
