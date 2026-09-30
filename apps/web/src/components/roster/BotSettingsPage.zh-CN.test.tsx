import type { ReactElement } from "react";
import {
  DEFAULT_UNIFIED_SETTINGS,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
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
  ) => selector(DEFAULT_UNIFIED_SETTINGS),
}));
vi.mock("./rosterStore", () => ({
  useRosterStore: (selector: (store: { bots: Bot[] }) => unknown) => selector({ bots: state.bots }),
}));
vi.mock("./useBotThreadRef", () => ({ useBotThreadRef: () => null }));
vi.mock("../ui/toast", () => ({ toastManager: { add: vi.fn() } }));
vi.mock("../../i18n", async () => {
  const { catalogRegistry, createTranslator } = await import("@akeru/client-runtime/i18n");
  const translator = createTranslator("zh-CN", await catalogRegistry["zh-CN"]!());
  return { useI18n: () => translator };
});

import { BotSettingsPage } from "./BotSettingsPage";

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

function textOf(node: unknown): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (node && typeof node === "object" && "props" in node) {
    return textOf((node as Tree).props.children);
  }
  return "";
}

describe("bot settings in Simplified Chinese", () => {
  beforeEach(() => {
    hooks.reset();
    state.bots = [makeBot()];
    state.providers = [codexProvider()];
  });

  it("translates the section titles and navigation", () => {
    const form = renderForm();
    const nav = visitElements(form, (element) => element.type === "nav");
    expect(nav?.props["aria-label"]).toBe("机器人设置分区");
    expect(textOf(nav)).toBe("身份行为模型与用量工作区工具");
    expect(textOf(form)).toContain("设置这个机器人与你协作的方式。");

    const titles: unknown[] = [];
    visitElements(form, (element) => {
      if ("id" in element.props && typeof element.props.title === "string") {
        titles.push(element.props.title);
      }
      return false;
    });
    expect(titles).toEqual(expect.arrayContaining(["身份", "行为", "模型与用量", "工作区"]));
    expect(titles).not.toContain("Identity");
  });
});
