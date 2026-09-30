import type { VoiceAudio } from "@akeru/client-runtime/voice";

const MAX_AUDIO_BYTES = 4 * 1024 * 1024;
const MAX_UTTERANCE_MS = 20_000;
const SILENCE_MS = 900;

export function recordingMimeType(): string {
  const mimeType = ["audio/webm;codecs=opus", "audio/mp4", "audio/ogg;codecs=opus"].find(
    (candidate) => MediaRecorder.isTypeSupported(candidate),
  );
  if (!mimeType) throw new Error("This browser cannot record supported voice audio.");
  return mimeType;
}

function createCaptureResources(microphone: MediaStream) {
  let context: AudioContext | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  try {
    const recorder = new MediaRecorder(microphone, { mimeType: recordingMimeType() });
    context = new AudioContext();
    source = context.createMediaStreamSource(microphone);
    const analyser = context.createAnalyser();
    analyser.fftSize = 2048;
    source.connect(analyser);
    return { recorder, context, source, analyser };
  } catch (error) {
    source?.disconnect();
    if (context) void context.close().catch(() => undefined);
    throw error;
  }
}

export function captureVoiceUtterance(
  microphone: MediaStream,
  signal: AbortSignal,
): Promise<VoiceAudio> {
  signal.throwIfAborted();
  if (typeof MediaRecorder === "undefined" || typeof AudioContext === "undefined") {
    return Promise.reject(new Error("Voice recording is unavailable on this client."));
  }
  return new Promise((resolve, reject) => {
    const { recorder, context, source, analyser } = createCaptureResources(microphone);
    const samples = new Float32Array(analyser.fftSize);
    let chunks: Blob[] = [];
    let size = 0;
    let started = performance.now();
    let lastSpeech: number | null = null;
    let settled = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    const cleanup = () => {
      clearInterval(timer);
      signal.removeEventListener("abort", abort);
      recorder.ondataavailable = null;
      recorder.onstop = null;
      recorder.onerror = null;
      if (recorder.state !== "inactive") recorder.stop();
      microphone.getAudioTracks().forEach((track) => {
        track.enabled = false;
      });
      source.disconnect();
      void context.close().catch(() => undefined);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const abort = () => fail(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    recorder.onerror = () => fail(new Error("The microphone recording failed."));
    recorder.ondataavailable = (event) => {
      chunks.push(event.data);
      size += event.data.size;
      if (size > MAX_AUDIO_BYTES) fail(new Error("The voice recording was too large."));
    };
    recorder.onstop = () => {
      if (settled) return;
      if (lastSpeech === null) {
        chunks = [];
        size = 0;
        started = performance.now();
        try {
          recorder.start(250);
        } catch (error) {
          fail(error);
        }
        return;
      }
      const mimeType = recorder.mimeType.split(";", 1)[0] as VoiceAudio["mimeType"];
      const blob = new Blob(chunks, { type: mimeType });
      settled = true;
      cleanup();
      void blob
        .arrayBuffer()
        .then((buffer) => {
          signal.throwIfAborted();
          const bytes = new Uint8Array(buffer);
          let binary = "";
          for (let offset = 0; offset < bytes.length; offset += 8192) {
            binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
          }
          resolve({ audioBase64: btoa(binary), mimeType });
        })
        .catch(reject);
    };
    microphone.getAudioTracks().forEach((track) => {
      track.enabled = true;
    });
    void context.resume().catch(fail);
    try {
      recorder.start(250);
    } catch (error) {
      fail(error);
      return;
    }
    timer = setInterval(() => {
      if (recorder.state !== "recording") return;
      analyser.getFloatTimeDomainData(samples);
      const rms = Math.sqrt(
        samples.reduce((sum, value) => sum + value * value, 0) / samples.length,
      );
      const now = performance.now();
      if (rms > 0.02) lastSpeech = now;
      if (
        now - started >= MAX_UTTERANCE_MS ||
        (lastSpeech !== null && now - lastSpeech >= SILENCE_MS)
      ) {
        recorder.stop();
      }
    }, 50);
  });
}

export function playVoiceAudio(
  speaker: HTMLAudioElement,
  audio: VoiceAudio,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  const binary = atob(audio.audioBase64);
  if (binary.length > MAX_AUDIO_BYTES)
    return Promise.reject(new Error("Voice audio was too large."));
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: audio.mimeType }));
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      speaker.removeEventListener("ended", ended);
      speaker.removeEventListener("error", failed);
      signal.removeEventListener("abort", aborted);
      speaker.pause();
      speaker.removeAttribute("src");
      URL.revokeObjectURL(url);
      if (error !== undefined) reject(error);
      else resolve();
    };
    const ended = () => finish();
    const failed = () => finish(new Error("Could not play the voice response."));
    const aborted = () => finish(signal.reason);
    speaker.addEventListener("ended", ended, { once: true });
    speaker.addEventListener("error", failed, { once: true });
    signal.addEventListener("abort", aborted, { once: true });
    speaker.src = url;
    void speaker.play().catch(finish);
  });
}
