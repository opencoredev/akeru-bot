import { useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import {
  createAutomaticReadoutTracker,
  createReplyPlaybackController,
  createReplyReadoutPreference,
  replyMarkdownToSpokenText,
} from "@t3tools/client-runtime/reply-playback";
import {
  MessageControls,
  type MessageReactionOption,
} from "../../src/components/chat/MessageControls";
import { ReplyReadoutPreference } from "../../src/components/chat/ReplyReadoutPreference";
import { createBrowserReplyAudio } from "../../src/lib/replyPlaybackAudio";
import { TooltipProvider } from "../../src/components/ui/tooltip";
import "./fixture.css";

// Test-only tone. Production playback must use LEO-401's real synthesis operation.
function tone() {
  const rate = 16000;
  const frames = rate * 60;
  const bytes = new ArrayBuffer(44 + frames * 2);
  const view = new DataView(bytes);
  const label = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
  };
  label(0, "RIFF");
  view.setUint32(4, bytes.byteLength - 8, true);
  label(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  label(36, "data");
  view.setUint32(40, frames * 2, true);
  for (let i = 0; i < frames; i++)
    view.setInt16(44 + i * 2, Math.sin((i * 2 * Math.PI * 440) / rate) * 4096, true);
  return new Blob([bytes], { type: "audio/wav" });
}
let preparations = 0;
let fail = false;
let hold = false;
let release: (() => void) | undefined;
const controller = createReplyPlaybackController(async (_request, signal, events) => {
  preparations++;
  if (hold)
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  if (signal.aborted) throw new Error("Cancelled fixture");
  if (fail) throw new Error("Fixture failure");
  return createBrowserReplyAudio(tone(), events);
});
const base = {
  environmentId: "remote-fixture",
  threadId: "chat",
  provider: "fixture-only",
  voice: "tone",
};
controller.setContext({ ...base, connected: true, mediaBlocked: false });
const tracker = createAutomaticReadoutTracker();
tracker.reset("chat", 0);
let sequence = 0;
const preference = createReplyReadoutPreference(
  {
    getItem: async (key) => localStorage.getItem(key),
    setItem: async (key, value) => {
      localStorage.setItem(key, value);
    },
  },
  controller.disableAutomaticReadout,
);
preference.subscribe(() => tracker.setEnabled(preference.getSnapshot().enabled));
void preference.load();
const markdown =
  "# Stored reply\n\nRead **this answer** and [the guide](https://example.com).\n\n```ts\nsecretToolTrace();\n```";
const spoken = replyMarkdownToSpokenText(markdown);
const disclosure = `${spoken.skipped.codeBlocks} code block skipped.`;

function Fixture() {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const [reaction, setReaction] = useState<MessageReactionOption | null>(null);
  const [quote, setQuote] = useState("");
  const [otherChat, setOtherChat] = useState(false);
  const [version, setVersion] = useState("1");
  const request = (messageId: string) => ({
    identity: { ...base, messageId, contentVersion: version },
    text: spoken.text,
    automatic: false,
  });
  return (
    <TooltipProvider>
      <main className="mx-auto max-w-2xl space-y-6 p-4">
        <h1 className="text-xl">Reply playback test fixture</h1>
        <p>This is deterministic test audio, not provider synthesis.</p>
        <ReplyReadoutPreference preference={preference} />
        {!otherChat ? (
          ["first", "second"].map((messageId) => (
            <article key={messageId} className="space-y-2 rounded border p-3">
              <h2>{messageId} stored reply</h2>
              <p>{spoken.text}</p>
              <MessageControls
                copyText={markdown}
                onReply={() => setQuote(messageId)}
                selectedReaction={reaction}
                onReactionChange={setReaction}
                readAloud={{ controller, request: request(messageId), disclosure }}
              />
            </article>
          ))
        ) : (
          <h2>Another chat</h2>
        )}
        <label className="block">
          Reply target
          <input
            className="block border"
            value={quote}
            onChange={(event) => setQuote(event.target.value)}
          />
        </label>
        <output className="block" data-testid="playback-state">
          {state.status}
        </output>
        <output className="block" data-testid="preparations">
          Preparations: {preparations}
        </output>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => {
              const next = !otherChat;
              controller.setContext({
                ...base,
                threadId: next ? "other" : "chat",
                connected: true,
                mediaBlocked: false,
              });
              tracker.reset(next ? "other" : "chat", sequence);
              setOtherChat(next);
            }}
          >
            Navigate chat
          </button>
          <button
            onClick={() =>
              controller.setContext({ ...base, connected: false, mediaBlocked: false })
            }
          >
            Disconnect
          </button>
          <button
            onClick={() => {
              controller.setContext({ ...base, connected: true, mediaBlocked: false });
              tracker.hydrate(sequence);
            }}
          >
            Reconnect
          </button>
          <button
            onClick={() => controller.setContext({ ...base, connected: true, mediaBlocked: true })}
          >
            Start live call
          </button>
          <button
            onClick={() => controller.setContext({ ...base, connected: true, mediaBlocked: false })}
          >
            Hang up
          </button>
          <button
            onClick={() => {
              const next = String(Number(version) + 1);
              controller.reconcileMessages(
                new Map([
                  ["first", next],
                  ["second", next],
                ]),
              );
              setVersion(next);
            }}
          >
            Edit reply
          </button>
          <button onClick={() => controller.reconcileMessages(new Map())}>Delete reply</button>
          <button
            onClick={() => {
              sequence++;
              const next = tracker.completed("chat", sequence, {
                ...request(`auto-${sequence}`).identity,
                text: spoken.text,
                successful: true,
              });
              if (next) void controller.start({ ...request(next.messageId), automatic: true });
            }}
          >
            Complete new reply
          </button>
          <button
            onClick={() => {
              tracker.hydrate(sequence);
              tracker.completed("chat", sequence, {
                messageId: "history",
                contentVersion: "1",
                text: spoken.text,
                successful: true,
              });
            }}
          >
            Hydrate history
          </button>
          <label>
            <input
              type="checkbox"
              onChange={(event) => {
                fail = event.target.checked;
              }}
            />
            Fail synthesis
          </label>
          <label>
            <input
              type="checkbox"
              onChange={(event) => {
                hold = event.target.checked;
              }}
            />
            Hold synthesis
          </label>
          <button onClick={() => release?.()}>Release synthesis</button>
        </div>
      </main>
    </TooltipProvider>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
