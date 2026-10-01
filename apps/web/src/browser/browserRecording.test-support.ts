import * as Predicate from "effect/Predicate";
import { vi } from "vite-plus/test";

const {
  events,
  frameSubscription,
  onFrame,
  registrySet,
  save,
  startScreencast,
  stopScreencast,
  surfaceState,
} = vi.hoisted(() => {
  const events: string[] = [];

  type Frame = {
    readonly tabId: string;
    readonly data: string;
    readonly width: number;
    readonly height: number;
    readonly receivedAt: string;
  };

  const frameSubscription: { listener: ((frame: Frame) => void) | null } = {
    listener: null,
  };

  const surfaceState = {
    byTabId: {} as Record<string, unknown>,
  };

  return {
    events,
    frameSubscription,
    onFrame: vi.fn((listener: (frame: Frame) => void) => {
      frameSubscription.listener = listener;

      return () => {
        if (frameSubscription.listener === listener) frameSubscription.listener = null;
      };
    }),
    registrySet: vi.fn((_atom: unknown, value: { readonly tabIds: ReadonlySet<string> }) => {
      events.push(
        value.tabIds.size === 0 ? "clear" : `publish:${Array.from(value.tabIds).join(",")}`,
      );
    }),
    save: vi.fn(async (tabId: string) => ({
      id: "recording-test",
      tabId,
      path: "/tmp/recording-test.webm",
      mimeType: "video/webm" as const,
      sizeBytes: 0,
      createdAt: "2026-06-26T00:00:00.000Z",
    })),
    startScreencast: vi.fn(async (tabId: string) => {
      events.push("start-screencast");

      const surface = surfaceState.byTabId[tabId] as
        | {
            readonly content?: { readonly width: number; readonly height: number };
            readonly rect?: { readonly width: number; readonly height: number };
          }
        | undefined;

      const size = surface?.content ?? surface?.rect;
      frameSubscription.listener?.({
        tabId,
        data: "initial-frame",
        width: size?.width ?? 1280,
        height: size?.height ?? 800,
        receivedAt: "2026-06-26T00:00:00.000Z",
      });
    }),
    stopScreencast: vi.fn(async () => undefined),
    surfaceState,
  };
});

vi.mock("~/components/preview/previewBridge", () => ({
  previewBridge: {
    recording: { onFrame, save, startScreencast, stopScreencast },
  },
}));

vi.mock("~/rpc/atomRegistry", () => ({
  appAtomRegistry: { set: registrySet },
}));

vi.mock("./browserSurfaceStore", () => ({
  useBrowserSurfaceStore: {
    getState: () => surfaceState,
  },
}));

export class FakeMediaRecorder {
  static isTypeSupported(): boolean {
    return true;
  }

  state: RecordingState = "inactive";
  private readonly listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  start(): void {
    this.state = "recording";
  }

  stop(): void {
    this.state = "inactive";

    for (const listener of this.listeners.get("stop") ?? []) {
      if (Predicate.isFunction(listener)) listener(new Event("stop"));
      else listener.handleEvent(new Event("stop"));
    }
  }
}

export const emitRecordingFrame = () => {
  frameSubscription.listener?.({
    tabId: "recording-tab",
    data: "startup-frame",
    width: 800,
    height: 600,
    receivedAt: "2026-06-26T00:00:00.000Z",
  });
};

export function setupRecordingTest() {
  events.length = 0;
  frameSubscription.listener = null;
  surfaceState.byTabId = {
    "recording-tab": {
      visible: true,
      rect: { x: 0, y: 0, width: 800, height: 600 },
      content: { x: 0, y: 0, width: 800, height: 600, scale: 1, scrollLeft: 0, scrollTop: 0 },
    },
  };
  vi.clearAllMocks();
  vi.stubGlobal("window", globalThis);
  vi.stubGlobal("MediaRecorder", FakeMediaRecorder as unknown as typeof MediaRecorder);

  class ImmediateImage {
    private loadListener: EventListenerOrEventListenerObject | undefined;

    addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
      if (type === "load") this.loadListener = listener;
    }

    set src(_value: string) {
      const event = new Event("load");

      if (Predicate.isFunction(this.loadListener)) this.loadListener(event);
      else this.loadListener?.handleEvent(event);
    }
  }

  vi.stubGlobal("Image", ImmediateImage as unknown as typeof Image);
  vi.stubGlobal("document", {
    createElement: () => ({
      width: 0,
      height: 0,
      captureStream: () => ({}),
      getContext: () => ({ drawImage: vi.fn(), fillRect: vi.fn(), fillStyle: "" }),
    }),
  });
}

export function cleanupRecordingTest() {
  vi.useRealTimers();
  vi.unstubAllGlobals();
}

export {
  events,
  frameSubscription,
  onFrame,
  registrySet,
  save,
  startScreencast,
  stopScreencast,
  surfaceState,
};
