import type { DictationCapture, DictationDependencies } from "@t3tools/client-runtime/dictation";
import {
  AudioModule,
  AudioQuality,
  IOSOutputFormat,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  type RecordingOptions,
  type RecordingStatus,
} from "expo-audio";
import { File } from "expo-file-system";
import { AppState } from "react-native";

/** Mono AAC in an MP4 container keeps a minute of speech far below the transcription upload cap. */
export const DICTATION_RECORDING: RecordingOptions = {
  extension: ".m4a",
  sampleRate: 16_000,
  numberOfChannels: 1,
  bitRate: 32_000,
  android: { outputFormat: "mpeg4", audioEncoder: "aac" },
  ios: { outputFormat: IOSOutputFormat.MPEG4AAC, audioQuality: AudioQuality.MEDIUM },
  web: { mimeType: "audio/webm", bitsPerSecond: 32_000 },
};

const PERMISSION_DENIED =
  "Microphone permission was denied. Allow it for Akeru Bot in your device settings.";

/**
 * Records one dictation to a temporary file, returns its bytes on stop, and always deletes the file.
 * Backgrounding the app or a recorder failure ends the capture through `onError`.
 */
export const startExpoDictationCapture: DictationDependencies["capture"] = async ({
  signal,
  limits,
  onError,
}) => {
  signal.throwIfAborted();
  const permission = await requestRecordingPermissionsAsync();
  signal.throwIfAborted();
  if (!permission.granted) throw new Error(PERMISSION_DENIED);
  await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
  // Until dispose exists, a setup failure must hand the audio session back itself.
  const leaveRecordingMode = (cause: unknown, release?: () => void): never => {
    release?.();
    void setAudioModeAsync({ allowsRecording: false }).catch(() => undefined);
    throw cause;
  };

  let recorder: InstanceType<typeof AudioModule.AudioRecorder>;
  try {
    recorder = new AudioModule.AudioRecorder(DICTATION_RECORDING);
  } catch (cause) {
    return leaveRecordingMode(cause);
  }
  let disposed = false;
  let stopping = false;
  let startedAt = 0;
  let statusSubscription: ReturnType<typeof recorder.addListener>;
  try {
    statusSubscription = recorder.addListener(
      "recordingStatusUpdate",
      (status: RecordingStatus) => {
        if (disposed || stopping) return;
        if (status.hasError || status.mediaServicesDidReset) {
          onError(new Error(status.error ?? "The microphone stopped recording."));
        }
      },
    );
  } catch (cause) {
    return leaveRecordingMode(cause, () => recorder.release());
  }
  const appSubscription = AppState.addEventListener("change", (state) => {
    if (!disposed && state !== "active") {
      onError(new Error("Dictation stopped because Akeru Bot left the foreground."));
    }
  });
  const deleteRecording = () => {
    const uri = recorder.uri;
    if (!uri) return;
    try {
      const file = new File(uri);
      if (file.exists) file.delete();
    } catch {
      // The recorder may not have written a file yet.
    }
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    statusSubscription.remove();
    appSubscription.remove();
    const finish = () => {
      deleteRecording();
      recorder.release();
      void setAudioModeAsync({ allowsRecording: false }).catch(() => undefined);
    };
    if (recorder.isRecording) void recorder.stop().then(finish, finish);
    else finish();
  };
  signal.addEventListener("abort", dispose, { once: true });

  try {
    await recorder.prepareToRecordAsync(DICTATION_RECORDING);
    signal.throwIfAborted();
    recorder.record();
    startedAt = Date.now();
  } catch (error) {
    dispose();
    throw error;
  }

  const capture: DictationCapture = {
    async stop() {
      if (disposed) throw new Error("Dictation capture was released.");
      stopping = true;
      await recorder.stop();
      const durationMs = Date.now() - startedAt;
      const uri = recorder.uri;
      if (!uri) throw new Error("The recording could not be saved.");
      const file = new File(uri);
      if (file.size > limits.maxAudioBytes) throw new Error("The recording is too long.");
      const bytes = await file.bytes();
      return { bytes, mediaType: "audio/mp4", durationMs };
    },
    dispose,
  };
  return capture;
};
