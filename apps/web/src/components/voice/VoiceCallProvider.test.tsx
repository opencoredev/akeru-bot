import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  activeProject: { id: "project-1", environmentId: "env-1", workspaceRoot: "/tmp/project" },
  bot: {
    id: "bot-akeru",
    name: "Akeru",
    title: "Generalist",
    label: null,
    description: null,
    disabledMcpServerIds: [],
    avatar: { kind: "blob", shape: "circle", color: "#5B7FD4" },
    engine: null,
    sandbox: null,
    runtimeMode: "full-access",
    usageCap: null,
    voiceEnabled: true,
    groupId: null,
    pinned: false,
    archivedAt: null,
    createdAt: "2026-08-27T00:00:00.000Z",
    updatedAt: "2026-08-27T00:00:00.000Z",
  },
  hangupVoiceCall: vi.fn(async () => ({ _tag: "Success", value: undefined })),
  navigate: vi.fn(async () => undefined),
  selectBot: vi.fn(),
  send: vi.fn(async () => true),
  appendTranscript: vi.fn(async () => undefined),
  startAtom: {},
  hangupAtom: {},
  startVoiceCall: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => [] }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => mocks.navigate }));
vi.mock("../../hooks/useSettings", () => ({
  usePrimarySettings: (selector?: (settings: { voice: { enabled: boolean } }) => unknown) => {
    const settings = { voice: { enabled: true } };
    return selector ? selector(settings) : settings;
  },
}));
vi.mock("../../modelSelection", () => ({
  resolveAppModelSelectionState: () => ({ instanceId: "codex", model: "gpt-5.6" }),
}));
vi.mock("../../providerInstances", () => ({
  applyProviderInstanceSettings: (entries: unknown) => entries,
  deriveProviderInstanceEntries: () => [],
  sortProviderInstanceEntries: (entries: unknown) => entries,
}));
vi.mock("../../state/entities", () => ({ useProjects: () => [mocks.activeProject] }));
vi.mock("../../state/environments", () => ({
  useEnvironmentConnectionState: () => ({ data: null }),
  usePrimaryEnvironmentId: () => "env-1",
}));
vi.mock("../../state/server", () => ({
  primaryServerProvidersAtom: {},
  serverEnvironment: {
    startVoiceCall: mocks.startAtom,
    hangupVoiceCall: mocks.hangupAtom,
  },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (atom: unknown) =>
    atom === mocks.startAtom ? mocks.startVoiceCall : mocks.hangupVoiceCall,
}));
vi.mock("../roster/botEngineSelection", () => ({
  resolveStickyBotEngine: () => ({ instanceId: "codex", model: "gpt-5.6" }),
}));
vi.mock("../roster/useBotThreadRuntime", () => ({
  useBotThreadRuntime: () => ({
    appendTranscript: mocks.appendTranscript,
    bootstrapped: true,
    botReady: true,
    defaultProject: mocks.activeProject,
    error: null,
    latestTurn: null,
    messages: [],
    send: mocks.send,
    sending: false,
  }),
}));
vi.mock("../roster/rosterStore", () => {
  const state = { bots: [mocks.bot], selectedBotId: mocks.bot.id, selectBot: mocks.selectBot };
  return {
    useRosterStore: Object.assign((selector: (value: typeof state) => unknown) => selector(state), {
      getState: () => state,
    }),
  };
});
vi.mock("../ui/toast", () => ({ toastManager: { add: mocks.toast } }));

import { VoiceCallProvider, useVoiceCall } from "./VoiceCall";

type VoiceControls = ReturnType<typeof useVoiceCall>;

let latestPeer: TestPeer | null = null;

class TestPeer {
  iceGatheringState: RTCIceGatheringState = "complete";
  connectionState: RTCPeerConnectionState = "connected";
  localDescription: RTCSessionDescription | null = null;
  ontrack: ((event: RTCTrackEvent) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  readonly events = {
    readyState: "open" as RTCDataChannelState,
    onmessage: null as ((event: MessageEvent) => void) | null,
    onerror: null as (() => void) | null,
    onclose: null as (() => void) | null,
    send: vi.fn(),
  };
  constructor() {
    latestPeer = this;
  }
  addTrack() {}
  addEventListener() {}
  removeEventListener() {}
  close() {}
  createDataChannel() {
    return this.events as unknown as RTCDataChannel;
  }
  async createOffer(): Promise<RTCSessionDescriptionInit> {
    return { type: "offer", sdp: "offer-sdp" };
  }
  async setLocalDescription(description: RTCSessionDescriptionInit) {
    this.localDescription = description as RTCSessionDescription;
  }
  async setRemoteDescription() {}
}

function renderControls(): VoiceControls {
  let controls: VoiceControls | null = null;
  function Probe() {
    controls = useVoiceCall();
    return null;
  }
  renderToStaticMarkup(
    <VoiceCallProvider>
      <Probe />
    </VoiceCallProvider>,
  );
  if (controls === null) throw new Error("Voice controls did not mount.");
  return controls;
}

async function flushVoiceStart() {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

describe("voice call provider", () => {
  const track = {
    enabled: true,
    stop: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  const microphone = {
    getTracks: () => [track],
    getAudioTracks: () => [track],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    latestPeer = null;
    vi.stubGlobal("RTCPeerConnection", TestPeer);
    vi.stubGlobal(
      "Audio",
      class {
        autoplay = false;
        srcObject: MediaProvider | null = null;
        pause() {}
        async play() {}
      },
    );
    mocks.startVoiceCall.mockResolvedValue({
      _tag: "Success",
      value: {
        call: {
          callId: "call-1",
          status: "live",
          botId: mocks.bot.id,
          botName: mocks.bot.name,
          startedAt: "2026-08-27T00:00:00.000Z",
        },
        answerSdp: "answer-sdp",
      },
    });
  });

  it("refuses a second start while the first call is pending and lets hangup cancel it", async () => {
    let resolveMicrophone!: (value: typeof microphone) => void;
    const pendingMicrophone = new Promise<typeof microphone>((resolve) => {
      resolveMicrophone = resolve;
    });
    vi.stubGlobal("navigator", {
      mediaDevices: { getUserMedia: vi.fn(() => pendingMicrophone) },
    });
    const controls = renderControls();

    controls.startOrReturn(mocks.bot as never);
    controls.startOrReturn({ ...mocks.bot, id: "bot-other", name: "Other" } as never);
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledOnce();

    controls.hangup();
    resolveMicrophone(microphone);
    await flushVoiceStart();
    expect(track.stop).toHaveBeenCalled();
    expect(mocks.startVoiceCall).not.toHaveBeenCalled();
  });

  it("returns to the active bot instead of starting a second call", async () => {
    vi.stubGlobal("navigator", {
      mediaDevices: { getUserMedia: vi.fn(async () => microphone) },
    });
    const controls = renderControls();

    controls.startOrReturn(mocks.bot as never);
    await flushVoiceStart();
    expect(mocks.startVoiceCall).toHaveBeenCalledOnce();

    controls.startOrReturn(mocks.bot as never);
    expect(mocks.startVoiceCall).toHaveBeenCalledOnce();
    expect(mocks.selectBot).toHaveBeenCalledWith(mocks.bot.id);
    expect(mocks.navigate).toHaveBeenCalledWith({
      to: "/bots/$botId",
      params: { botId: mocks.bot.id },
    });
  });

  it("uses speech-safe microphone constraints and resumes input after playback drains", async () => {
    vi.stubGlobal("navigator", {
      mediaDevices: { getUserMedia: vi.fn(async () => microphone) },
    });
    const controls = renderControls();

    controls.startOrReturn(mocks.bot as never);
    await flushVoiceStart();

    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });
    latestPeer?.events.onmessage?.(
      new MessageEvent("message", {
        data: JSON.stringify({ type: "output_audio_buffer.started" }),
      }),
    );
    expect(track.enabled).toBe(false);
    latestPeer?.events.onmessage?.(
      new MessageEvent("message", {
        data: JSON.stringify({ type: "response.done", response: { status: "completed" } }),
      }),
    );
    expect(track.enabled).toBe(false);
    latestPeer?.events.onmessage?.(
      new MessageEvent("message", {
        data: JSON.stringify({ type: "output_audio_buffer.stopped" }),
      }),
    );
    expect(track.enabled).toBe(true);
  });
});
