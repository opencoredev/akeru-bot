import { act, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ReplyPlaybackSession } from "@t3tools/client-runtime/reply-playback";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  primaryEnvironmentId: "primary" as string | null,
  voice: {} as Record<string, unknown>,
  session: null as ReplyPlaybackSession | null,
  audio: [] as Array<{ play: () => Promise<void>; pause: () => void; dispose: () => void }>,
  command: () => Promise.resolve({ _tag: "Success" }),
}));

vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => ({ voice: mocks.voice }),
}));
vi.mock("~/state/server", () => ({
  primaryServerSettingsAtom: "settings",
  serverEnvironment: { synthesizeVoice: "synthesize", cancelVoice: "cancel" },
}));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => mocks.command }));
vi.mock("~/state/environments", () => ({
  usePrimaryEnvironmentId: () => mocks.primaryEnvironmentId,
  useEnvironmentConnectionState: () => ({ data: null }),
}));
vi.mock("../components/voice/VoiceCall", () => ({ voiceEnvironmentConnectionLost: () => false }));
vi.mock("../components/chat/ReplyPlaybackProvider", () => ({
  useOptionalReplyPlayback: () => mocks.session,
}));
vi.mock("@t3tools/client-runtime/voice", () => ({
  synthesizeVoiceChunks: async () => [
    { _tag: "Success", value: { audioBase64: "", mimeType: "audio/mpeg" } },
  ],
}));
vi.mock("./replyPlaybackAudio", () => ({
  createBrowserReplyAudio: () => {
    const audio = { play: vi.fn(async () => {}), pause: vi.fn(), dispose: vi.fn() };
    mocks.audio.push(audio);
    return audio;
  },
}));

import { useWebReplyPlaybackSession } from "./replyPlaybackSession";
import { useReplyPlaybackThread } from "./replyPlaybackThread";

const reply = {
  id: "reply-1",
  role: "assistant" as const,
  streaming: false,
  text: "Stored answer",
  updatedAt: "2026-09-08T00:00:00.000Z",
};
const enabledVoice = { enabled: true, provider: "composed" };
let renders = 0;

function Chat(props: { environmentId: string; threadId: string | null }) {
  renders += 1;
  mocks.session = useWebReplyPlaybackSession();
  useReplyPlaybackThread({
    environmentId: props.environmentId as never,
    threadId: props.threadId,
    messages: [reply],
    mediaBlocked: false,
  });
  return null;
}

let root: Root;
const listeners = { addEventListener() {}, removeEventListener() {} };
// Components here render nothing, so the DOM only needs a document and a container.
class TestNode {
  readonly nodeName = "DIV";
  readonly tagName = "DIV";
  readonly namespaceURI = "http://www.w3.org/1999/xhtml";
  readonly addEventListener = listeners.addEventListener;
  readonly removeEventListener = listeners.removeEventListener;
  constructor(
    readonly nodeType = 1,
    readonly ownerDocument: TestNode | null = null,
  ) {}
}
const testDocument = new TestNode(9);
const createTestRoot = () => createRoot(new TestNode(1, testDocument) as never);

beforeEach(() => {
  renders = 0;
  mocks.primaryEnvironmentId = "primary";
  mocks.voice = enabledVoice;
  mocks.session = null;
  mocks.audio = [];
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("document", testDocument);
  vi.stubGlobal("window", { ...listeners, document: testDocument, HTMLIFrameElement: TestNode });
  root = createTestRoot();
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

const render = (environmentId: string, threadId: string | null = "thread") =>
  act(async () => root.render(<Chat environmentId={environmentId} threadId={threadId} />));

describe("web reply playback thread", () => {
  it("stops playing a reply when Voice is disabled in Settings", async () => {
    await render("primary");
    const session = mocks.session!;
    await act(() => session.controller.start(session.actionFor(reply)!.request));
    expect(session.controller.getSnapshot().status).toBe("playing");

    mocks.voice = { ...enabledVoice, enabled: false };
    await render("primary");

    expect(session.controller.getSnapshot().status).toBe("idle");
    expect(mocks.audio[0]!.dispose).toHaveBeenCalledOnce();
    expect(session.actionFor(reply)?.unavailableReason).toBe("Voice is disabled in Settings.");
  });

  it("keeps another environment's replies unavailable while primary speech is enabled", async () => {
    await render("remote");
    expect(mocks.session!.actionFor(reply)?.unavailableReason).toBe(
      "Reading replies aloud is only available for this device's primary environment.",
    );
  });

  it("settles after the chat context is cleared under a mounted subscriber", async () => {
    const snapshots = new Set<unknown>();
    function Subscriber({ session }: { session: ReplyPlaybackSession }) {
      snapshots.add(useSyncExternalStore(session.subscribeSynthesis, session.getSynthesisSnapshot));
      return null;
    }
    await render("primary");
    const session = mocks.session!;
    const subscriberRoot = createTestRoot();
    await act(async () => subscriberRoot.render(<Subscriber session={session} />));
    renders = 0;

    await render("primary", null);
    act(() => session.clearContextIf("primary", "thread"));

    expect(renders).toBeLessThan(5);
    expect(session.getSynthesisSnapshot()).toBe(session.getSynthesisSnapshot());
    expect(session.getSynthesisSnapshot().available).toBe(false);
    expect(snapshots.size).toBe(2);
    await act(async () => subscriberRoot.unmount());
  });
});
