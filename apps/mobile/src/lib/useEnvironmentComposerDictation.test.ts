import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({ alert: vi.fn(), errorMessage: null as string | null }));
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useMemo: <T>(factory: () => T) => factory(),
  useEffect: (effect: () => void) => effect(),
}));
vi.mock("react-native", () => ({ Alert: { alert: state.alert } }));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => undefined }));
vi.mock("../state/server", () => ({
  serverEnvironment: { settingsValueAtom: () => null, voiceProviders: () => null },
}));
vi.mock("../state/query", () => ({ useEnvironmentQuery: () => ({ data: undefined }) }));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("./useComposerDictation", () => ({
  useComposerDictation: () => ({
    errorMessage: state.errorMessage,
    status: "idle",
    unavailableReason: null,
    onStart: vi.fn(),
    onRelease: vi.fn(),
    onCancel: vi.fn(),
  }),
}));
vi.mock("./i18n", async () => {
  const { catalogRegistry, createTranslator } = await import("@t3tools/client-runtime/i18n");
  const translator = createTranslator("zh-CN", await catalogRegistry["zh-CN"]!());
  return { useMobileI18n: () => ({ t: translator.translate }) };
});

import { useEnvironmentComposerDictation } from "./useEnvironmentComposerDictation";

const bind = () =>
  useEnvironmentComposerDictation({
    environmentId: null,
    connected: true,
    threadId: "thread",
    draftId: "thread",
    generation: 0,
    getDraft: () => ({ text: "", selection: { start: 0, end: 0 } }),
    applyDraft: vi.fn(),
  });

beforeEach(() => {
  state.errorMessage = null;
  vi.clearAllMocks();
});

describe("useEnvironmentComposerDictation alerts", () => {
  it("translates the failure title and keeps the provider message verbatim", () => {
    state.errorMessage = "Transcription service timed out";
    bind();
    expect(state.alert).toHaveBeenCalledWith("无法听写", "Transcription service timed out");
  });

  it("translates the blocked title and keeps the unavailable reason verbatim", () => {
    bind().onBlockedPress!("Reconnect to dictate.");
    expect(state.alert).toHaveBeenCalledWith("听写不可用", "Reconnect to dictate.");
  });
});
