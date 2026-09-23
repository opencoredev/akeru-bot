import type { DictationDraft } from "@t3tools/client-runtime/dictation";
import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import { isValidElement, type ReactElement } from "react";
import { beforeEach, describe, expect, it, vi, type Mock } from "vite-plus/test";

import type { DraftComposerImageAttachment } from "../../lib/composerImages";

type Session = ReturnType<
  typeof import("@t3tools/client-runtime/dictation").createDictationSession
>;
type DictationInput = {
  readonly getDraft: () => Omit<DictationDraft, "identity">;
  readonly applyDraft: (draft: DictationDraft) => void;
};

const hooks = vi.hoisted(() => ({ slots: [] as unknown[], cursor: 0 }));
const fake = vi.hoisted(() => ({
  session: null as Session | null,
  input: null as DictationInput | null,
  transcribe: null as unknown as Mock<() => Promise<string>>,
}));

vi.mock("react", async (importOriginal) => {
  const slot = <T,>(create: () => T): { value: T } => {
    const index = hooks.cursor++;
    if (!(index in hooks.slots)) hooks.slots[index] = { value: create() };
    return hooks.slots[index] as { value: T };
  };
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    memo: <T,>(component: T) => component,
    useRef: <T,>(current: T) => slot(() => ({ current })).value,
    useMemo: <T,>(factory: () => T) => factory(),
    useCallback: <T,>(callback: T) => callback,
    useEffect: () => {},
    useState: <T,>(initial: T | (() => T)) => {
      const state = slot(() => (typeof initial === "function" ? (initial as () => T)() : initial));
      const set = (next: T | ((previous: T) => T)) => {
        state.value = typeof next === "function" ? (next as (previous: T) => T)(state.value) : next;
      };
      return [state.value, set];
    },
  };
});
vi.mock("react-native", () => ({
  ActivityIndicator: "ActivityIndicator",
  AccessibilityInfo: { announceForAccessibility: () => {} },
  Image: "Image",
  Platform: { OS: "ios", select: (options: { ios?: unknown }) => options.ios },
  Pressable: "Pressable",
  StyleSheet: { absoluteFill: {}, create: <T,>(styles: T) => styles },
  View: "View",
}));
vi.mock("react-native-reanimated", () => {
  const transition = { duration: () => transition };
  return {
    default: { View: "Animated.View" },
    FadeIn: transition,
    FadeInDown: transition,
    FadeOut: transition,
    FadeOutDown: transition,
    LinearTransition: transition,
  };
});
vi.mock("react-native-image-viewing", () => ({ default: "ImageViewing" }));
vi.mock("@react-navigation/native", () => ({
  StackActions: { push: vi.fn() },
  useFocusEffect: () => {},
  useNavigation: () => ({ dispatch: vi.fn(), addListener: () => () => {} }),
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => [] }));
vi.mock("../../components/AppSymbol", () => ({ SymbolView: "SymbolView" }));
vi.mock("../../components/AppText", () => ({ AppText: "Text" }));
vi.mock("../../components/ComposerAttachmentStrip", () => ({
  ComposerAttachmentStrip: "ComposerAttachmentStrip",
}));
vi.mock("../../components/GlassSurface", () => ({ GlassSurface: "GlassSurface" }));
vi.mock("../../components/ComposerEditor", () => ({ ComposerEditor: "ComposerEditor" }));
vi.mock("../../components/ComposerToolbar", () => ({
  ComposerInlineControl: "ComposerInlineControl",
  ComposerToolbarButton: "ComposerToolbarButton",
  ComposerToolbarRow: "ComposerToolbarRow",
  ComposerToolbarScroller: "ComposerToolbarScroller",
}));
vi.mock("../../components/ControlPill", () => ({ ControlPill: "ControlPill" }));
vi.mock("../../components/ProviderIcon", () => ({ ProviderIcon: "ProviderIcon" }));
vi.mock("../../lib/useThemeColor", () => ({ useThemeColor: () => "#000000" }));
vi.mock("../../lib/modelOptions", () => ({
  buildModelOptions: () => [],
  groupByProvider: () => [],
  resolveModelSendBlock: () => null,
}));
vi.mock("../settings/appearance/useScaledTextRole", () => ({ useScaledTextRole: () => ({}) }));
vi.mock("../settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({ themeAppearance: "light" }),
}));
vi.mock("../../lib/providerOptions", () => ({ resolveProviderOptionDescriptors: () => [] }));
vi.mock("../../state/use-composer-path-search", () => ({
  useComposerPathSearch: () => ({ entries: [], isPending: false }),
}));
vi.mock("../../state/bots", () => ({
  botEnvironment: { update: Symbol("update") },
  environmentBotsAtom: () => Symbol("bots"),
}));
vi.mock("./thread-list-v2-items", () => ({ providerBotName: () => "Codex" }));
vi.mock("../../state/server", () => ({
  serverEnvironment: { subscriptionAuth: () => Symbol("subscriptionAuth") },
}));
vi.mock("../../state/query", () => ({ useEnvironmentQuery: () => ({ data: null }) }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("./ComposerCommandPopover", () => ({ ComposerCommandPopover: "ComposerCommandPopover" }));
vi.mock("./ComposerMentionPopover", () => ({ ComposerMentionPopover: "ComposerMentionPopover" }));
vi.mock("./ThreadSettingsSheet", () => ({
  useExistingThreadSettingsRoutePresentation: () => ({ present: vi.fn(), clear: vi.fn() }),
}));
vi.mock("./use-thread-settings-sheet-presentation", () => ({
  useThreadSettingsSheetPresentation: () => ({
    isActive: false,
    isVisible: false,
    open: vi.fn(),
    onDismissed: vi.fn(),
    onStackTransitionsFinished: vi.fn(),
  }),
}));
// The real session runs behind the environment binding: capture succeeds, transcription fails.
vi.mock("../../lib/useEnvironmentComposerDictation", async () => {
  const { createDictationSession, dictationControlStatus } =
    await import("@t3tools/client-runtime/dictation");
  const identity = { environmentId: "environment", threadId: "thread", draftId: "thread" };
  return {
    useEnvironmentComposerDictation: (input: DictationInput) => {
      fake.input = input;
      const draft = () => ({ identity: { ...identity, generation: 0 }, ...input.getDraft() });
      fake.session ??= createDictationSession({
        capture: async () => ({
          stop: async () => ({
            bytes: new Uint8Array([1]),
            mediaType: "audio/mp4",
            durationMs: 900,
          }),
          dispose: () => {},
        }),
        transcribe: fake.transcribe,
        updateDraft: (update) => fake.input!.applyDraft(update(draft())),
        schedule: (callback, milliseconds) => globalThis.setTimeout(callback, milliseconds),
        cancelSchedule: (timer) => globalThis.clearTimeout(timer as ReturnType<typeof setTimeout>),
      });
      const session = fake.session;
      return {
        status: dictationControlStatus(session.status),
        unavailableReason: null,
        onStart: () => session.start(draft()),
        onRelease: () => session.finish(),
        onCancel: () => session.cancel(),
      };
    },
  };
});

import { DictationControls, type DictationControlsProps } from "../../components/DictationControls";
import { ThreadComposer, type ThreadComposerProps } from "./ThreadComposer";

type Element = ReactElement<Record<string, unknown>>;

function findElement(node: unknown, accept: (element: Element) => boolean): Element | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElement(child, accept);
      if (found) return found;
    }
    return null;
  }
  if (!isValidElement<Record<string, unknown>>(node)) return null;
  if (accept(node)) return node;
  for (const value of Object.values(node.props)) {
    const found = findElement(value, accept);
    if (found) return found;
  }
  return null;
}

const attachment: DraftComposerImageAttachment = {
  id: "image-1",
  type: "image",
  name: "screenshot.png",
  mimeType: "image/png",
  sizeBytes: 4,
  dataUrl: "data:image/png;base64,AAAA",
  previewUri: "file:///cache/screenshot.png",
};

// The screen that owns the draft; the composer only reads it and reports edits.
const host = {
  draftMessage: "",
  draftAttachments: [] as ReadonlyArray<DraftComposerImageAttachment>,
  onChangeDraftMessage: vi.fn((value: string) => {
    host.draftMessage = value;
  }),
  onRemoveDraftImage: vi.fn(),
};

function render() {
  hooks.cursor = 0;
  const props = {
    ...host,
    placeholder: "Message",
    connectionState: "connected",
    connectionError: null,
    environmentLabel: null,
    selectedThread: {
      id: ThreadId.make("thread"),
      botId: null,
      session: null,
      runtimeMode: "full-access",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    } as unknown as OrchestrationThreadShell,
    serverConfig: null,
    queueCount: 0,
    environmentId: EnvironmentId.make("environment"),
    projectCwd: null,
    onPickDraftImages: vi.fn(),
    onNativePasteImages: vi.fn(),
    onStopThread: vi.fn(),
    onSendMessage: vi.fn(),
    onUpdateModelSelection: vi.fn(),
    onUpdateRuntimeMode: vi.fn(),
    onUpdateInteractionMode: vi.fn(),
    onReconnectEnvironment: vi.fn(),
  } satisfies ThreadComposerProps;
  const tree = (ThreadComposer as unknown as (props: ThreadComposerProps) => unknown)(props);
  const slot = findElement(tree, (element) => element.type === DictationControls);
  // Render the send-slot controls in the same pass so their hooks keep stable slots.
  const controls = slot ? DictationControls(slot.props as unknown as DictationControlsProps) : null;
  return {
    editor: findElement(tree, (element) => element.type === "ComposerEditor")!,
    thumbnail: findElement(tree, (element) => element.type === "Image"),
    find: (label: string) =>
      findElement([tree, controls], (element) => element.props.accessibilityLabel === label),
  };
}

const tap = (element: Element | null) => (element!.props.onAccessibilityTap as () => void)();

beforeEach(() => {
  hooks.slots = [];
  hooks.cursor = 0;
  host.draftMessage = "";
  host.draftAttachments = [];
  host.onChangeDraftMessage.mockClear();
  host.onRemoveDraftImage.mockClear();
  fake.session = null;
  fake.input = null;
  fake.transcribe = vi.fn(async () => {
    throw new Error("Transcription failed. Try again.");
  });
});

describe("ThreadComposer dictation failure", () => {
  it("keeps typed text and attachments through retry and dismiss", async () => {
    (render().editor.props.onChangeText as (value: string) => void)("Why does this crash?");
    const attachments = [attachment];
    host.draftAttachments = attachments;
    const seeded = render();
    expect(seeded.find("Send")).not.toBeNull();
    expect(seeded.editor.props.value).toBe("Why does this crash?");

    // A draft shows Send, so drive the composer's session directly, as a hold that began earlier would.
    await fake.session!.start({
      identity: {
        environmentId: "environment",
        threadId: "thread",
        draftId: "thread",
        generation: 0,
      },
      ...fake.input!.getDraft(),
    });
    await fake.session!.finish();
    expect(fake.session!.status).toBe("error");

    const failed = render();
    expect(failed.find("Retry dictation")).not.toBeNull();
    expect(failed.find("Dismiss dictation error")).not.toBeNull();
    expect(failed.find("Send")).toBeNull();

    tap(failed.find("Retry dictation"));
    await vi.waitFor(() => expect(fake.session!.status).toBe("recording"));
    tap(render().find("Stop dictation"));
    await vi.waitFor(() => expect(fake.session!.status).toBe("error"));
    expect(fake.transcribe).toHaveBeenCalledTimes(2);

    const retried = render();
    expect(retried.editor.props.value).toBe("Why does this crash?");
    expect(retried.thumbnail?.props.source).toEqual({ uri: attachment.previewUri });
    expect(host.draftAttachments).toBe(attachments);
    expect(retried.find("Dismiss dictation error")).not.toBeNull();

    (retried.find("Dismiss dictation error")!.props.onPress as () => void)();
    expect(fake.session!.status).toBe("cancelled");
    const dismissed = render();
    expect(dismissed.find("Retry dictation")).toBeNull();
    expect(dismissed.find("Send")?.props.disabled).toBe(false);
    expect(dismissed.editor.props.value).toBe("Why does this crash?");
    expect(dismissed.thumbnail?.props.source).toEqual({ uri: attachment.previewUri });
    expect(host.draftMessage).toBe("Why does this crash?");
    expect(host.draftAttachments).toBe(attachments);
    expect(host.draftAttachments[0]).toBe(attachment);
    expect(host.onChangeDraftMessage).toHaveBeenCalledTimes(1);
    expect(host.onRemoveDraftImage).not.toHaveBeenCalled();
  });
});
