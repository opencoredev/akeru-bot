import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import {
  DesktopPreviewRecordingFrameSchema,
  type DesktopPreviewRecordingFrame,
} from "@akeru/contracts";
import { contextBridge, ipcRenderer } from "electron";

import { PREVIEW_PICTURE_IN_PICTURE_FRAME_CHANNEL } from "./ipc/channels.ts";

const decodeFrame = Schema.decodeUnknownOption(DesktopPreviewRecordingFrameSchema);

contextBridge.exposeInMainWorld("previewPictureInPicture", {
  onFrame: (listener: (frame: DesktopPreviewRecordingFrame) => void) => {
    const wrappedListener: Parameters<typeof ipcRenderer.on>[1] = (_event, frame) => {
      const parsed = decodeFrame(frame);

      if (Option.isSome(parsed)) listener(parsed.value);
    };

    ipcRenderer.on(PREVIEW_PICTURE_IN_PICTURE_FRAME_CHANNEL, wrappedListener);

    return () =>
      ipcRenderer.removeListener(PREVIEW_PICTURE_IN_PICTURE_FRAME_CHANNEL, wrappedListener);
  },
});
