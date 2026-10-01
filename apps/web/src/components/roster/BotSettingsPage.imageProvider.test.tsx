import type { ReactElement } from "react";
import {
  DEFAULT_UNIFIED_SETTINGS,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ImageGenerationSettings,
  type ServerProvider,
} from "@akeru/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { visitElements } from "../../test/reactElementTree";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";
import type { Bot } from "./types";

const atoms = vi.hoisted(() => ({
  providers: Symbol("providers"),
  mcpServers: Symbol("mcpServers"),
  update: Symbol("botUpdate"),
}));

const state = vi.hoisted(() => ({
  bots: [] as Bot[],
  providers: [] as ServerProvider[],
  imageGeneration: null as ImageGenerationSettings | null,
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

vi.mock("@tanstack/react-router", () => ({
  useBlocker: () => {},
  useCanGoBack: () => false,
  useNavigate: () => vi.fn(),
}));

vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: symbol) => (atom === atoms.providers ? state.providers : []),
}));

vi.mock("../../state/server", () => ({
  primaryServerProvidersAtom: atoms.providers,
  serverEnvironment: {
    imageProviders: () => Symbol("imageProviders"),
    subscriptionAuth: () => Symbol("subscriptionAuth"),
  },
}));
vi.mock("../../state/mcpServers", () => ({ environmentMcpServersAtom: () => atoms.mcpServers }));
vi.mock("../../state/bots", () => ({ botEnvironment: { update: atoms.update } }));
vi.mock("../../state/environments", () => ({
  usePrimaryEnvironmentId: () => EnvironmentId.make("environment-1"),
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (atom: symbol) => (atom === atoms.update ? state.updateBot : vi.fn()),
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({ data: null, error: null, isPending: true, refresh: vi.fn() }),
}));
vi.mock("../../hooks/useSettings", () => ({
  usePrimarySettings: () => DEFAULT_UNIFIED_SETTINGS,
  useEnvironmentSettings: (
    _environmentId: EnvironmentId,
    selector: (settings: typeof DEFAULT_UNIFIED_SETTINGS) => unknown,
  ) =>
    selector({
      ...DEFAULT_UNIFIED_SETTINGS,
      imageGeneration: state.imageGeneration ?? DEFAULT_UNIFIED_SETTINGS.imageGeneration,
    }),
}));
vi.mock("./rosterStore", () => ({
  useRosterStore: (selector: (store: { bots: Bot[] }) => unknown) => selector({ bots: state.bots }),
}));
vi.mock("./useBotThreadRef", () => ({ useBotThreadRef: () => null }));
vi.mock("../ui/toast", () => ({ toastManager: { add: vi.fn() } }));
vi.mock("../../i18n", async () => {
  const { createTranslator } = await import("@akeru/client-runtime/i18n");
  const translator = createTranslator("en");
  return { useI18n: () => ({ ...translator, t: translator.translate }) };
});

import { BotSettingsPage } from "./BotSettingsPage";

const environmentId = EnvironmentId.make("environment-1");
const codexId = ProviderInstanceId.make("codex");

function codexProvider(): ServerProvider {
  return {
    instanceId: codexId,
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-09-01T00:00:00.000Z",
    models: [
      { slug: "gpt-5", name: "GPT-5", isCustom: false, capabilities: null },
      { slug: "gpt-5-mini", name: "GPT-5 mini", isCustom: false, capabilities: null },
    ],
    slashCommands: [],
    skills: [],
  } as unknown as ServerProvider;
}

function makeBot(overrides: Partial<Bot> = {}): Bot {
  return {
    id: "bot-1",
    name: "Scout",
    title: "Scout",
    label: null,
    description: null,
    disabledMcpServerIds: [],
    avatar: { kind: "shape", shape: "circle", color: "blue" } as unknown as Bot["avatar"],
    engine: { provider: codexId, model: "gpt-5" },
    sandbox: "local",
    runtimeMode: "full-access",
    usageCap: null,
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

type Tree = ReactElement<Record<string, unknown>>;

/** Renders the page, then the form it mounts, the way React would on each pass. */
function renderForm(): Tree {
  hooks.beginRender();
  const page = BotSettingsPage({ botId: "bot-1" }) as Tree;
  const formElement = visitElements(
    page,
    (element) => typeof element.props.onSave === "function" && "bot" in element.props,
  );
  expect(formElement).not.toBeNull();
  const Form = formElement!.type as (props: Record<string, unknown>) => Tree;
  return Form(formElement!.props);
}

function imageSelect(tree: Tree) {
  const select = visitElements(
    tree,
    (element) =>
      typeof element.props.onValueChange === "function" &&
      visitElements(
        element.props.children,
        (child) => child.props["aria-label"] === "Image provider",
      ) !== null,
  );
  expect(select).not.toBeNull();
  return select!.props as {
    readonly value: string;
    readonly onValueChange: (value: string) => void;
    readonly children: unknown;
  };
}

function textOf(node: unknown): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (node && typeof node === "object" && "props" in node) {
    return textOf((node as Tree).props.children);
  }
  return "";
}

function selectedLabel(tree: Tree): string {
  const trigger = visitElements(
    imageSelect(tree).children,
    (element) => element.props["aria-label"] === "Image provider",
  );
  return textOf(trigger?.props.children);
}

function saveButton(tree: Tree) {
  const button = visitElements(
    tree,
    (element) => element.props.onClick !== undefined && textOf(element.props.children) === "Save",
  );
  expect(button).not.toBeNull();
  return button!.props as { readonly disabled: boolean; readonly onClick: () => void };
}

function modelPicker(tree: Tree) {
  const picker = visitElements(
    tree,
    (element) =>
      typeof element.props.onChange === "function" && "activeInstanceId" in element.props,
  );
  expect(picker).not.toBeNull();
  return picker!.props as {
    readonly activeInstanceId: string;
    readonly model: string;
    readonly onChange: (instanceId: string, model: string) => void;
  };
}

async function flushPromises(): Promise<void> {
  for (let index = 0; index < 4; index += 1) await Promise.resolve();
}

function expectedUpdate(bot: Bot, overrides: Record<string, unknown>) {
  return {
    environmentId,
    input: {
      botId: bot.id,
      name: bot.name,
      label: null,
      description: null,
      engine: bot.engine,
      usageCap: null,
      sandbox: bot.sandbox,
      personalityTone: 50,
      voiceEnabled: false,
      imageProvider: null,
      disabledMcpServerIds: [],
      ...overrides,
    },
  };
}

describe("bot settings image provider", () => {
  beforeEach(() => {
    hooks.reset();
    state.bots = [makeBot()];
    state.providers = [codexProvider()];
    state.imageGeneration = {
      chatgptEnabled: true,
      grokEnabled: true,
      defaultProvider: "chatgpt",
      fallbackOrder: ["chatgpt", "grok"],
    };
    state.updateBot.mockReset().mockResolvedValue({ _tag: "Success" });
  });

  it("starts on the global default without unsaved changes", () => {
    const tree = renderForm();
    expect(imageSelect(tree).value).toBe("default");
    expect(selectedLabel(tree)).toBe("Use global default (ChatGPT)");
    expect(saveButton(tree).disabled).toBe(true);
  });

  it("preserves inheritance until Local is explicitly selected", async () => {
    state.bots = [makeBot({ sandbox: null })];
    let tree = renderForm();
    expect(saveButton(tree).disabled).toBe(true);
    const select = visitElements(
      tree,
      (element) =>
        typeof element.props.onValueChange === "function" &&
        visitElements(
          element.props.children,
          (child) => child.props["aria-label"] === "Sandbox provider",
        ) !== null,
    );
    expect(select?.props.value).toBe("default");
    (select!.props.onValueChange as (value: string) => void)("local");
    tree = renderForm();
    expect(saveButton(tree).disabled).toBe(false);
    saveButton(tree).onClick();
    await flushPromises();
    expect(state.updateBot).toHaveBeenCalledWith(
      expectedUpdate(state.bots[0]!, { sandbox: "local" }),
    );
  });

  it("preserves an inherited sandbox while saving another field", async () => {
    state.bots = [makeBot({ sandbox: null })];
    imageSelect(renderForm()).onValueChange("grok");
    saveButton(renderForm()).onClick();
    await flushPromises();
    expect(state.updateBot).toHaveBeenCalledWith(
      expectedUpdate(state.bots[0]!, { imageProvider: "grok", sandbox: null }),
    );
  });

  it("can restore the default sandbox from an explicit choice", async () => {
    state.bots = [makeBot({ sandbox: "railway" })];
    const tree = renderForm();
    const select = visitElements(
      tree,
      (element) =>
        typeof element.props.onValueChange === "function" &&
        visitElements(
          element.props.children,
          (child) => child.props["aria-label"] === "Sandbox provider",
        ) !== null,
    );
    (select!.props.onValueChange as (value: string) => void)("default");
    saveButton(renderForm()).onClick();
    await flushPromises();
    expect(state.updateBot).toHaveBeenCalledWith(expectedUpdate(state.bots[0]!, { sandbox: null }));
  });

  it("keeps a removed saved provider visible while editing another field", async () => {
    const missingId = ProviderInstanceId.make("removed_claude");
    state.bots = [makeBot({ engine: { provider: missingId, model: "sonnet" } })];

    let tree = renderForm();
    expect(modelPicker(tree).activeInstanceId).toBe(missingId);
    const notice = visitElements(tree, (element) =>
      Boolean(element.props.presentation && typeof element.props.presentation === "object"),
    );
    expect(notice?.props.presentation).toMatchObject({ reason: "missing-provider" });

    imageSelect(tree).onValueChange("grok");
    tree = renderForm();
    saveButton(tree).onClick();
    await flushPromises();
    expect(state.updateBot).toHaveBeenCalledWith(
      expectedUpdate(state.bots[0]!, { imageProvider: "grok" }),
    );
  });

  it.each([
    ["grok", "Grok"],
    ["chatgpt", "ChatGPT"],
  ] as const)("saves %s as the bot's image provider", async (provider, label) => {
    imageSelect(renderForm()).onValueChange(provider);

    let tree = renderForm();
    expect(imageSelect(tree).value).toBe(provider);
    expect(selectedLabel(tree)).toBe(label);
    expect(saveButton(tree).disabled).toBe(false);

    saveButton(tree).onClick();
    await flushPromises();
    expect(state.updateBot).toHaveBeenCalledTimes(1);
    expect(state.updateBot).toHaveBeenCalledWith(
      expectedUpdate(state.bots[0]!, { imageProvider: provider }),
    );

    // The roster refreshes with the saved bot; the draft now matches it.
    state.bots = [makeBot({ imageProvider: provider })];
    tree = renderForm();
    expect(imageSelect(tree).value).toBe(provider);
    expect(saveButton(tree).disabled).toBe(true);
    expect(textOf(tree)).toContain("Saved");
  });

  it("clears a saved provider back to the global default", async () => {
    state.bots = [makeBot({ imageProvider: "grok" })];
    let tree = renderForm();
    expect(imageSelect(tree).value).toBe("grok");

    imageSelect(tree).onValueChange("default");
    tree = renderForm();
    expect(imageSelect(tree).value).toBe("default");
    expect(selectedLabel(tree)).toBe("Use global default (ChatGPT)");

    saveButton(tree).onClick();
    await flushPromises();
    expect(state.updateBot).toHaveBeenCalledWith(
      expectedUpdate(state.bots[0]!, { imageProvider: null }),
    );
  });

  it("keeps the image choice and the chat model independent", async () => {
    imageSelect(renderForm()).onValueChange("grok");
    let tree = renderForm();
    expect(modelPicker(tree).model).toBe("gpt-5");

    modelPicker(tree).onChange(codexId, "gpt-5-mini");
    tree = renderForm();
    expect(imageSelect(tree).value).toBe("grok");
    expect(modelPicker(tree).model).toBe("gpt-5-mini");

    imageSelect(tree).onValueChange("chatgpt");
    tree = renderForm();
    expect(modelPicker(tree).model).toBe("gpt-5-mini");

    saveButton(tree).onClick();
    await flushPromises();
    expect(state.updateBot).toHaveBeenCalledWith(
      expectedUpdate(state.bots[0]!, {
        engine: { provider: codexId, model: "gpt-5-mini" },
        imageProvider: "chatgpt",
      }),
    );
  });

  it("changing only the chat model saves the bot's image choice unchanged", async () => {
    state.bots = [makeBot({ imageProvider: "grok" })];
    modelPicker(renderForm()).onChange(codexId, "gpt-5-mini");
    const tree = renderForm();
    expect(imageSelect(tree).value).toBe("grok");

    saveButton(tree).onClick();
    await flushPromises();
    expect(state.updateBot).toHaveBeenCalledWith(
      expectedUpdate(state.bots[0]!, {
        engine: { provider: codexId, model: "gpt-5-mini" },
        imageProvider: "grok",
      }),
    );
  });
});
