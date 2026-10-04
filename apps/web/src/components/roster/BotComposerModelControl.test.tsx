import type { TestValue } from "../test-support/reactTree";
import { decodeServerProvider } from "../test-support/fixtures";
import { Predicate } from "effect";
import {
  DEFAULT_UNIFIED_SETTINGS,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ModelCapabilities,
  type ServerProvider,
} from "@akeru/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { visitElements } from "../test-support/reactTree";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";
import type { Bot } from "./types";

const atoms = vi.hoisted(() => ({
  providers: Symbol("providers"),
  keybindings: Symbol("keybindings"),
  update: Symbol("botUpdate"),
}));

const state = vi.hoisted(() => ({
  bots: [] as Bot[],
  providers: [] as ServerProvider[],
  updateBot: vi.fn(),
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");

  return {
    ...actual,
    useCallback: reactHookHarness.useCallback,
    useEffect: () => {},
    useMemo: reactHookHarness.useMemo,
    useRef: reactHookHarness.useRef,
    useState: reactHookHarness.useState,
  };
});

vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");

  return { c: reactHookHarness.useMemoCache };
});

vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: symbol) => (atom === atoms.providers ? state.providers : []),
}));

vi.mock("../../state/server", () => ({
  primaryServerProvidersAtom: atoms.providers,
  primaryServerKeybindingsAtom: atoms.keybindings,
}));

vi.mock("../../state/bots", () => ({ botEnvironment: { update: atoms.update } }));

vi.mock("../../state/environments", () => ({
  usePrimaryEnvironmentId: () => EnvironmentId.make("environment-1"),
}));

vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (atom: symbol) => (atom === atoms.update ? state.updateBot : vi.fn()),
}));

vi.mock("../../hooks/useSettings", () => ({
  usePrimarySettings: () => DEFAULT_UNIFIED_SETTINGS,
}));

vi.mock("./rosterStore", () => ({
  useRosterStore: <T,>(selector: (store: { bots: Bot[] }) => T) => selector({ bots: state.bots }),
}));

vi.mock("../ui/toast", () => ({ toastManager: { add: vi.fn() } }));

vi.mock("../../i18n", async () => {
  const { createTranslator } = await import("@akeru/client-runtime/i18n");
  const translator = createTranslator("en");

  return { useI18n: () => ({ ...translator, t: translator.translate }) };
});

import { BotComposerModelControl } from "./BotComposerModelControl";

const reasoning = (levels: ReadonlyArray<string>): ModelCapabilities => ({
  optionDescriptors: [
    {
      id: "reasoningEffort",
      label: "Reasoning",
      type: "select",
      currentValue: "default",
      options: [
        { id: "default", label: "Provider default", isDefault: true },
        ...levels.map((id) => ({ id, label: id })),
      ],
    },
  ],
});

function provider(instance: string): ServerProvider {
  return decodeServerProvider({
    instanceId: ProviderInstanceId.make(instance),
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-09-01T00:00:00.000Z",
    models: [
      {
        slug: "gpt-a",
        name: "A",
        isCustom: false,
        isDefault: true,
        capabilities: reasoning(["minimal", "high"]),
      },
      { slug: "gpt-b", name: "B", isCustom: false, capabilities: reasoning(["high"]) },
    ],
    slashCommands: [],
    skills: [],
  });
}

function makeBot(overrides: Partial<Bot> = {}): Bot {
  return {
    id: "bot-1",
    name: "Scout",
    title: "Scout",
    label: null,
    description: null,
    disabledMcpServerIds: [],
    avatar: { kind: "blob", shape: "circle", color: "#2E8EFF" },
    engine: {
      provider: "codex",
      model: "gpt-a",
      options: [{ id: "reasoningEffort", value: "minimal" }],
    },
    sandbox: "local",
    runtimeMode: "full-access",
    personalityTone: 50,
    voiceEnabled: false,
    imageProvider: null,
    groupId: null,
    pinned: false,
    archivedAt: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

function render(botId = "bot-1", disabled = false): TestValue {
  hooks.beginRender();

  return BotComposerModelControl({ botId, disabled }) as TestValue;
}

function traitsPicker(tree: TestValue) {
  return visitElements(tree, (element) => Predicate.isFunction(element.props.onModelOptionsChange));
}

function modelPicker(tree: TestValue) {
  const picker = visitElements(tree, (element) =>
    Predicate.isFunction(element.props.onInstanceModelChange),
  );

  expect(picker).not.toBeNull();

  return picker!.props as {
    readonly disabled: boolean;
    readonly onInstanceModelChange: (instanceId: ProviderInstanceId, model: string) => void;
  };
}

function savedEngine() {
  return state.updateBot.mock.calls.at(-1)?.[0];
}

describe("bot composer model control", () => {
  beforeEach(() => {
    hooks.reset();
    state.bots = [makeBot()];
    state.providers = [provider("codex"), provider("codex_work")];
    state.updateBot = vi.fn(async () => ({ _tag: "Success" }));
  });

  it("offers model selection without a composer reasoning control", () => {
    const tree = render();

    expect(traitsPicker(tree)).toBeNull();
    expect(modelPicker(tree).disabled).toBe(false);
    expect(state.updateBot).not.toHaveBeenCalled();
  });

  it("keeps supported choices across models on one instance and clears them across instances", () => {
    const picker = modelPicker(render());

    picker.onInstanceModelChange(ProviderInstanceId.make("codex"), "gpt-b");
    expect(savedEngine()?.input.engine).toEqual({ provider: "codex", model: "gpt-b" });

    state.bots = [
      makeBot({
        engine: {
          provider: "codex",
          model: "gpt-a",
          options: [{ id: "reasoningEffort", value: "high" }],
        },
      }),
    ];
    modelPicker(render()).onInstanceModelChange(ProviderInstanceId.make("codex"), "gpt-b");
    expect(savedEngine()?.input.engine).toEqual({
      provider: "codex",
      model: "gpt-b",
      options: [{ id: "reasoningEffort", value: "high" }],
    });

    modelPicker(render()).onInstanceModelChange(ProviderInstanceId.make("codex_work"), "gpt-a");
    expect(savedEngine()?.input.engine).toEqual({ provider: "codex_work", model: "gpt-a" });
  });

  it("hides the reasoning control in a read-only composer", () => {
    const tree = render("bot-1", true);

    expect(traitsPicker(tree)).toBeNull();
    expect(modelPicker(tree).disabled).toBe(true);
  });

  it("renders nothing for a group or archived bot, so no engine is written", () => {
    expect(render("group-1")).toBeNull();

    state.bots = [makeBot({ archivedAt: "2026-09-02T00:00:00.000Z" })];
    expect(render()).toBeNull();
    expect(state.updateBot).not.toHaveBeenCalled();
  });
});
