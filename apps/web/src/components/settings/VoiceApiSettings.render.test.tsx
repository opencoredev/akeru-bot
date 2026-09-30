import { EnvironmentId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  providers: [] as Array<{ provider: string; connected: boolean }>,
}));

vi.mock("../../state/server", () => ({
  serverEnvironment: { voiceProviders: () => ({}) },
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({
    data: { providers: mocks.providers },
    error: null,
    refresh: vi.fn(),
  }),
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../../confirmDialog", () => ({ requestConfirmDialog: vi.fn() }));

import { ComposedVoiceRows, VoiceApiConnectionsSection } from "./VoiceApiSettings";

const environmentId = EnvironmentId.make("environment-1");

describe("voice API settings", () => {
  beforeEach(() => {
    mocks.providers = [];
  });

  it("offers Connect for a service without a key", () => {
    mocks.providers = [{ provider: "openai", connected: false }];
    const markup = renderToStaticMarkup(
      <VoiceApiConnectionsSection environmentId={environmentId} />,
    );
    expect(markup).toContain("API connections");
    expect(markup).toContain("OpenAI API");
    expect(markup).toContain("Not connected");
    expect(markup).toContain(">Connect<");
    expect(markup).toContain("Test API access");
    expect(markup).toContain("Disconnect");
  });

  it("offers Replace key for a connected service", () => {
    mocks.providers = [{ provider: "openai", connected: true }];
    const markup = renderToStaticMarkup(
      <VoiceApiConnectionsSection environmentId={environmentId} />,
    );
    expect(markup).toContain("Connected");
    expect(markup).toContain("Replace key");
  });

  it("shows the selected composed services and voice", () => {
    const markup = renderToStaticMarkup(
      <ComposedVoiceRows
        environmentId={environmentId}
        voice={{
          enabled: true,
          provider: "composed",
          voice: "alloy",
          transcriptionProvider: "elevenlabs",
          synthesisProvider: "fish",
          synthesisVoices: { fish: "voice-fish-1" },
        }}
        onChange={() => {}}
      />,
    );
    expect(markup).toContain("Transcription service");
    expect(markup).toContain("ElevenLabs");
    expect(markup).toContain("Fish Audio");
    expect(markup).toContain("voice-fish-1");
    expect(markup).toContain("Refresh speech voices");
  });
});
