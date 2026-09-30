import { catalogRegistry } from "@t3tools/client-runtime/i18n";
import { VOICE_API_PROVIDERS, type VoiceApiProvider } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("../../state/server", () => ({ serverEnvironment: {} }));
vi.mock("../../state/query", () => ({ useEnvironmentQuery: () => ({}) }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("~/state/environments", () => ({ usePrimaryEnvironment: () => null }));
vi.mock("../../confirmDialog", () => ({ requestConfirmDialog: vi.fn() }));
vi.mock("../chat/ReplyPlaybackProvider", () => ({ useOptionalReplyPlayback: () => null }));

import { LanguageProvider } from "../../i18n";
import { VoiceApiProviderRow } from "./VoiceSettings";

const zhCNCatalog = await catalogRegistry["zh-CN"]!();

function renderRow(
  provider: VoiceApiProvider,
  connected: boolean,
  chinese: boolean,
  keyRejected = false,
) {
  const row = (
    <VoiceApiProviderRow
      provider={provider}
      connected={connected}
      keyRejected={keyRejected}
      busyAction={null}
      disabled={false}
      message={null}
      onConnect={async () => true}
      onTest={() => {}}
      onDisconnect={() => {}}
    />
  );
  return renderToStaticMarkup(
    chinese ? (
      <LanguageProvider testCatalog={{ locale: "zh-CN", catalog: zhCNCatalog }}>
        {row}
      </LanguageProvider>
    ) : (
      row
    ),
  );
}

describe("voice API key labels", () => {
  it("name each key once in English and Simplified Chinese", () => {
    expect(renderRow("openai", false, false)).toContain('placeholder="OpenAI API key"');
    expect(renderRow("fish", false, false)).toContain('placeholder="Fish Audio API key"');
    expect(renderRow("openai", false, true)).toContain('placeholder="OpenAI API 密钥"');
    expect(renderRow("cartesia", false, true)).toContain('aria-label="Cartesia API 密钥"');
    for (const provider of VOICE_API_PROVIDERS) {
      for (const chinese of [false, true]) {
        for (const connected of [false, true]) {
          expect(renderRow(provider, connected, chinese)).not.toMatch(/API\s*API/);
        }
      }
    }
  });

  it("translates the key status badge", () => {
    expect(renderRow("openai", true, true)).toContain("密钥已保存");
    const rejected = renderRow("openai", true, true, true);
    expect(rejected).toContain("密钥被拒绝");
    expect(rejected).not.toContain("Key rejected");
    expect(renderRow("openai", false, true)).toContain("未连接");
  });
});
