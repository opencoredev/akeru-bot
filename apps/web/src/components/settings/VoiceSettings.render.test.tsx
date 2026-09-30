import { DEFAULT_SERVER_SETTINGS, type VoiceSettings } from "@akeru/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("../../state/server", () => ({ serverEnvironment: {} }));
vi.mock("../../state/query", () => ({ useEnvironmentQuery: () => ({}) }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("~/state/environments", () => ({ usePrimaryEnvironment: () => null }));
vi.mock("~/hooks/useSettings", () => ({
  usePrimarySettings: vi.fn(),
  useUpdatePrimarySettings: () => vi.fn(),
}));
vi.mock("../../confirmDialog", () => ({ requestConfirmDialog: vi.fn() }));
vi.mock("../chat/ReplyPlaybackProvider", () => ({ useOptionalReplyPlayback: () => null }));

import type { EnvironmentId } from "@akeru/contracts";
import { VoiceApiProviderRow, VoiceModeRows } from "./VoiceSettings";

const environmentId = "environment-1" as EnvironmentId;

function renderMode(
  voice: Partial<VoiceSettings>,
  connected: ReadonlyArray<"openai" | "fish"> | null,
) {
  return renderToStaticMarkup(
    <VoiceModeRows
      voice={{ ...DEFAULT_SERVER_SETTINGS.voice, ...voice }}
      environmentId={environmentId}
      connected={connected}
      onChange={() => {}}
    />,
  );
}

function renderProvider(
  connected: boolean | undefined,
  message: null | { tone: "ok" | "error"; text: string } = null,
  keyRejected = false,
) {
  return renderToStaticMarkup(
    <VoiceApiProviderRow
      provider="elevenlabs"
      connected={connected}
      keyRejected={keyRejected}
      busyAction={null}
      disabled={false}
      message={message}
      onConnect={async () => true}
      onTest={() => {}}
      onDisconnect={() => {}}
    />,
  );
}

describe("voice mode rows", () => {
  it("keeps the ChatGPT subscription path unchanged", () => {
    const html = renderMode({}, []);
    expect(html).toContain("ChatGPT subscription");
    expect(html).toContain("No API key is billed");
    expect(html).toContain("Voice selection");
    expect(html).not.toContain("API connections");
    expect(html).not.toContain("Transcription provider");
  });

  it("explains realtime billing and flags a missing OpenAI key", () => {
    const html = renderMode({ provider: "openai" }, []);
    expect(html).toContain("OpenAI API voice");
    expect(html).toContain("interrupt the bot");
    expect(html).toContain("Connect OpenAI API under API connections");
  });

  it("shows speech-only composition without interruption and asks to connect the speech provider", () => {
    const html = renderMode(
      { provider: "composed", transcriptionProvider: "openai", synthesisProvider: "fish" },
      ["openai"],
    );
    expect(html).toContain("cannot be interrupted");
    expect(html).toContain("Transcription provider");
    expect(html).toContain("Speech provider");
    expect(html).toContain("Fish Audio");
    expect(html).toContain("Connect Fish Audio to choose a voice.");
    expect(html).toContain("Connect Fish Audio under API connections");
  });
});

describe("voice API provider row", () => {
  it("asks for a key when a provider is not connected", () => {
    const html = renderProvider(false);
    expect(html).toContain("Not connected");
    expect(html).toContain('type="password"');
    expect(html).toContain("ElevenLabs API key");
    expect(html).toContain("Transcription · Speech");
    expect(html).not.toContain("Disconnect");
  });

  it("offers test, replacement, and disconnect without revealing the key", () => {
    const html = renderProvider(true, { tone: "ok", text: "The provider accepted this key." });
    expect(html).toContain("Key saved");
    expect(html).toContain("Test ElevenLabs key");
    expect(html).toContain("Replace ElevenLabs key");
    expect(html).toContain("Disconnect ElevenLabs");
    expect(html).toContain("The provider accepted this key.");
    expect(html).not.toContain('type="password"');
  });

  it("reports provider errors as alerts and waits for status before offering actions", () => {
    const html = renderProvider(true, {
      tone: "error",
      text: "Could not reach the voice provider. Check the network and try again.",
    });
    expect(html).toContain('role="alert"');
    expect(html).toContain("Could not reach the voice provider");
    expect(html).toContain("Key saved");
    const loading = renderProvider(undefined);
    expect(loading).not.toContain("Not connected");
    expect(loading).not.toContain("Disconnect");
  });

  it("shows a rejected key in the danger tone instead of Key saved", () => {
    const html = renderProvider(
      true,
      {
        tone: "error",
        text: "The voice provider rejected the API key. Replace the key and test it again.",
      },
      true,
    );
    expect(html).toContain("Key rejected");
    expect(html).toContain("text-destructive-foreground");
    expect(html).not.toContain("Key saved");
    expect(html).not.toContain("in Settings");
    expect(html).toContain("Replace ElevenLabs key");
  });
});
