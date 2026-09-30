import type { ReactElement } from "react";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  type ImageGenerationSettings,
  type ImageProviderStatus,
  type UnifiedSettings,
} from "@akeru/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { visitElements } from "../../test/reactElementTree";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";

const atoms = vi.hoisted(() => ({
  testImageProvider: Symbol("testImageProvider"),
  logoutSubscriptionAuth: Symbol("logoutSubscriptionAuth"),
}));

const commands = vi.hoisted(() => ({
  test: vi.fn(),
  logout: vi.fn(),
}));

const query = vi.hoisted(() => ({
  lastAtom: null as unknown,
  providers: null as ReadonlyArray<ImageProviderStatus> | null,
  error: null as string | null,
  isPending: false,
  refresh: vi.fn(),
}));

const settingsState = vi.hoisted(() => ({
  imageGeneration: null as ImageGenerationSettings | null,
  updateSettings: vi.fn(),
}));

const navigation = vi.hoisted(() => ({ openSettings: vi.fn() }));
const confirm = vi.hoisted(() => ({ request: vi.fn() }));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useCallback: reactHookHarness.useCallback,
    useMemo: reactHookHarness.useMemo,
    useRef: reactHookHarness.useRef,
    useState: reactHookHarness.useState,
  };
});

vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});

vi.mock("../../state/server", () => ({
  serverEnvironment: {
    imageProviders: (args: unknown) => ({ imageProviders: args }),
    testImageProvider: atoms.testImageProvider,
    logoutSubscriptionAuth: atoms.logoutSubscriptionAuth,
  },
}));

vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (atom: unknown) => {
    query.lastAtom = atom;
    return {
      data: query.providers ? { providers: query.providers } : null,
      error: query.error,
      isPending: query.isPending,
      refresh: query.refresh,
    };
  },
}));

vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (atom: symbol) =>
    atom === atoms.testImageProvider ? commands.test : commands.logout,
}));

vi.mock("../../hooks/useSettings", () => ({
  useEnvironmentSettings: (
    _environmentId: EnvironmentId,
    selector: (settings: UnifiedSettings) => unknown,
  ) =>
    selector({
      ...DEFAULT_SERVER_SETTINGS,
      imageGeneration: settingsState.imageGeneration ?? DEFAULT_SERVER_SETTINGS.imageGeneration,
    } as UnifiedSettings),
  useUpdateEnvironmentSettings: () => settingsState.updateSettings,
}));

vi.mock("../../settingsDialogStore", () => ({
  openSettings: navigation.openSettings,
  useSettingsEnvironmentId: () => null,
}));

vi.mock("../../confirmDialog", () => ({ requestConfirmDialog: confirm.request }));

import {
  ImageGenerationRoutingSection,
  ImageGenerationSettingsContent,
  ImageProviderRow,
} from "./ImageGenerationSettings";

const environmentId = EnvironmentId.make("remote-device");

function providerStatus(
  provider: ImageProviderStatus["provider"],
  overrides: Partial<ImageProviderStatus> = {},
): ImageProviderStatus {
  return {
    provider,
    label: provider === "chatgpt" ? "ChatGPT" : "Grok",
    connected: true,
    enabled: true,
    health: "detected",
    operations: ["generate"],
    ...overrides,
  };
}

function renderContent(): ReactElement<Record<string, unknown>> {
  hooks.beginRender();
  return ImageGenerationSettingsContent({ environmentId }) as ReactElement<Record<string, unknown>>;
}

function findRow(tree: unknown, provider: ImageProviderStatus["provider"]) {
  const row = visitElements(
    tree,
    (element) => element.type === ImageProviderRow && element.props.provider === provider,
  );
  expect(row).not.toBeNull();
  return row!.props as {
    readonly status: ImageProviderStatus | undefined;
    readonly loadFailed: boolean;
    readonly onToggle: (enabled: boolean) => void;
    readonly onTest: () => void;
    readonly onDisconnect: () => void;
    readonly onConnect: () => void;
  };
}

async function flushPromises(): Promise<void> {
  for (let index = 0; index < 4; index += 1) await Promise.resolve();
}

describe("ImageGenerationSettingsContent environment wiring", () => {
  beforeEach(() => {
    hooks.reset();
    query.lastAtom = null;
    query.providers = [providerStatus("chatgpt"), providerStatus("grok")];
    query.error = null;
    query.isPending = false;
    query.refresh.mockReset();
    settingsState.imageGeneration = {
      chatgptEnabled: true,
      grokEnabled: false,
      defaultProvider: "chatgpt",
      fallbackOrder: ["chatgpt"],
    };
    settingsState.updateSettings.mockReset();
    commands.test.mockReset().mockResolvedValue({ _tag: "Success" });
    commands.logout.mockReset().mockResolvedValue({ _tag: "Success" });
    navigation.openSettings.mockReset();
    confirm.request.mockReset().mockResolvedValue(true);
  });

  it("lists image providers for the selected environment", () => {
    const tree = renderContent();
    expect(query.lastAtom).toEqual({ imageProviders: { environmentId, input: {} } });
    expect(findRow(tree, "grok").status?.provider).toBe("grok");
  });

  it("persists a provider toggle as an image generation settings patch", () => {
    findRow(renderContent(), "grok").onToggle(true);
    expect(settingsState.updateSettings).toHaveBeenCalledWith({
      imageGeneration: { grokEnabled: true, fallbackOrder: ["chatgpt", "grok"] },
    });
  });

  it("persists routing changes", () => {
    const routing = visitElements(
      renderContent(),
      (element) => element.type === ImageGenerationRoutingSection,
    );
    (routing?.props.onChange as (patch: object) => void)({ defaultProvider: "grok" });
    expect(settingsState.updateSettings).toHaveBeenCalledWith({
      imageGeneration: { defaultProvider: "grok" },
    });
  });

  it("runs the health test in this environment and refreshes provider status", async () => {
    findRow(renderContent(), "grok").onTest();
    await flushPromises();
    expect(commands.test).toHaveBeenCalledWith({ environmentId, input: { provider: "grok" } });
    expect(query.refresh).toHaveBeenCalledTimes(1);
  });

  it("disconnects the matching subscription after confirmation", async () => {
    findRow(renderContent(), "chatgpt").onDisconnect();
    await flushPromises();
    expect(confirm.request).toHaveBeenCalledTimes(1);
    expect(commands.logout).toHaveBeenCalledWith({
      environmentId,
      input: { provider: "openai-codex" },
    });
    expect(query.refresh).toHaveBeenCalledTimes(1);

    findRow(renderContent(), "grok").onDisconnect();
    await flushPromises();
    expect(commands.logout).toHaveBeenLastCalledWith({ environmentId, input: { provider: "xai" } });
  });

  it("keeps the subscription when the user cancels or no confirm host answers", async () => {
    confirm.request.mockResolvedValueOnce(false);
    findRow(renderContent(), "grok").onDisconnect();
    await flushPromises();

    confirm.request.mockReturnValueOnce(null);
    findRow(renderContent(), "grok").onDisconnect();
    await flushPromises();

    expect(commands.logout).not.toHaveBeenCalled();
    expect(query.refresh).not.toHaveBeenCalled();
  });

  it("opens the provider login row in the same environment", () => {
    findRow(renderContent(), "grok").onConnect();
    expect(navigation.openSettings).toHaveBeenCalledWith(
      "providers",
      "subscription-provider-xai",
      environmentId,
    );
    findRow(renderContent(), "chatgpt").onConnect();
    expect(navigation.openSettings).toHaveBeenLastCalledWith(
      "providers",
      "subscription-provider-openai-codex",
      environmentId,
    );
  });

  it("marks rows as loading while provider status is pending", () => {
    query.providers = null;
    query.isPending = true;
    const tree = renderContent();
    const row = findRow(tree, "grok");
    expect(row.status).toBeUndefined();
    expect(row.loadFailed).toBe(false);
    expect(
      visitElements(
        tree,
        (element) => element.props["aria-label"] === "Retry loading image providers",
      ),
    ).toBeNull();
  });

  it("reports a load failure and retries the provider query", () => {
    query.providers = null;
    query.error = "Connection lost";
    const tree = renderContent();
    expect(findRow(tree, "grok").loadFailed).toBe(true);
    const retry = visitElements(
      tree,
      (element) => element.props["aria-label"] === "Retry loading image providers",
    );
    expect(retry).not.toBeNull();
    (retry?.props.onClick as () => void)();
    expect(query.refresh).toHaveBeenCalledTimes(1);
  });
});
