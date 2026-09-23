import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationThreadShell,
  type ServerConfig,
} from "@t3tools/contracts";
import { isValidElement, type ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const hooks = vi.hoisted(() => ({ slots: [] as unknown[], cursor: 0 }));

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
vi.mock("../../lib/i18n", async () => {
  const { createTranslator } = await import("@t3tools/client-runtime/i18n");
  const translator = createTranslator("en");
  return { useMobileI18n: () => ({ t: translator.translate, plural: translator.plural }) };
});
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
vi.mock("../../lib/useEnvironmentComposerDictation", () => ({
  useEnvironmentComposerDictation: () => ({
    status: "idle",
    unavailableReason: null,
    onStart: () => {},
    onRelease: () => {},
    onCancel: () => {},
  }),
}));

import type { ComposerCommandItem } from "./ComposerCommandPopover";
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

// The thread's provider, whose skills and commands feed the `$` and `/` menus.
const serverConfig = {
  providers: [
    {
      instanceId: ProviderInstanceId.make("claudeAgent"),
      driver: ProviderDriverKind.make("claudeAgent"),
      enabled: true,
      installed: true,
      status: "ready",
      auth: { status: "authenticated" },
      models: [],
      slashCommands: [{ name: "compact", description: "Compact context" }],
      skills: [
        { name: "deploy", path: "/skills/deploy/SKILL.md", enabled: true },
        { name: "review", path: "/skills/review/SKILL.md", enabled: true },
        { name: "archived", path: "/skills/archived/SKILL.md", enabled: false },
      ],
    },
  ],
  settings: {},
} as unknown as ServerConfig;

function renderMenu(draftMessage: string) {
  hooks.slots = [];
  hooks.cursor = 0;
  const props = {
    draftMessage,
    draftAttachments: [],
    onChangeDraftMessage: vi.fn(),
    onRemoveDraftImage: vi.fn(),
    placeholder: "Message",
    connectionState: "connected",
    connectionError: null,
    environmentLabel: null,
    selectedThread: {
      id: ThreadId.make("thread"),
      botId: null,
      session: null,
      runtimeMode: "full-access",
      modelSelection: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude" },
    } as unknown as OrchestrationThreadShell,
    serverConfig,
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
  const popover = findElement(tree, (element) => element.type === "ComposerCommandPopover");
  return {
    triggerKind: popover?.props.triggerKind,
    labels: ((popover?.props.items ?? []) as ReadonlyArray<ComposerCommandItem>).map(
      (item) => item.label,
    ),
  };
}

beforeEach(() => {
  hooks.slots = [];
  hooks.cursor = 0;
});

describe("ThreadComposer command menus", () => {
  it("lists the provider's enabled skills after $", () => {
    expect(renderMenu("$")).toEqual({ triggerKind: "skill", labels: ["deploy", "review"] });
  });

  it("ranks $ skills by the typed query", () => {
    expect(renderMenu("$dep")).toEqual({ triggerKind: "skill", labels: ["deploy"] });
  });

  it("lists app commands, provider commands, and skills after /", () => {
    expect(renderMenu("/")).toEqual({
      triggerKind: "slash-command",
      labels: ["/model", "/plan", "/default", "/compact", "skill:deploy", "skill:review"],
    });
  });

  it("filters / rows by the typed query", () => {
    expect(renderMenu("/comp").labels).toEqual(["/compact"]);
  });

  it("shows no menu without a trigger", () => {
    expect(renderMenu("hello").triggerKind).toBeUndefined();
  });
});
