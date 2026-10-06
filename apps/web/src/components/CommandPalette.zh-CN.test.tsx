import { EnvironmentId, type CloudLinkStatus } from "@akeru/contracts";
import { catalogRegistry } from "@akeru/client-runtime/i18n";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { useSettingsDialogStore } from "../settingsDialogStore";
import { LanguageProvider } from "../i18n";
import type { CommandPaletteGroup } from "./CommandPalette.logic";

const cloud = vi.hoisted(() => ({
  status: "unlinked" as CloudLinkStatus["status"],
  connect: vi.fn(),
  connectAction: undefined as (() => Promise<void>) | undefined,
}));

vi.mock("../state/environments", async (original) => ({
  ...(await original<typeof import("../state/environments")>()),
  usePrimaryEnvironmentId: () => EnvironmentId.make("env-test"),
}));

vi.mock("../state/query", () => ({
  useEnvironmentQuery: () => ({ data: { status: cloud.status } }),
}));

vi.mock("./settings/useCloudLinkCommands", () => ({
  useCloudLinkCommands: () => ({ connect: cloud.connect, cancel: vi.fn(), disconnect: vi.fn() }),
}));

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => [] }));

vi.mock("../hooks/useTheme", () => ({
  useTheme: () => ({ resolvedTheme: "dark", setAppearanceMode: () => undefined }),
}));

// Render the dialog shell and results as plain markup so the titles are visible.
vi.mock("./ui/command", () => ({
  CommandDialog: ({ children }: { children: ReactNode }) => <>{children}</>,
  CommandDialogPopup: ({ children, ...props }: { children: ReactNode; "aria-label": string }) => (
    <div aria-label={props["aria-label"]}>{children}</div>
  ),
}));

vi.mock("./CommandPaletteContent", () => ({
  CommandPaletteContent: (props: {
    children: ReactNode;
    footerActionLabel: ReactNode;
    inputProps: { placeholder: string };
  }) => (
    <div>
      <input placeholder={props.inputProps.placeholder} />
      <span>{props.footerActionLabel}</span>
      {props.children}
    </div>
  ),
}));

vi.mock("./CommandPaletteResults", () => ({
  CommandPaletteResults: ({ groups }: { groups: ReadonlyArray<CommandPaletteGroup> }) => {
    const action = groups
      .flatMap((group) => group.items)
      .find((item) => item.value === "action:cloud-connect");

    cloud.connectAction = action && "run" in action ? action.run : undefined;

    return (
      <ul>
        {groups.map((group) => (
          <li key={group.value}>
            {group.label}
            {group.items.map((item) => (
              <span key={item.value}>{item.title}</span>
            ))}
          </li>
        ))}
      </ul>
    );
  },
}));

import { CommandPalette } from "./CommandPalette";

const zhCNCatalog = await catalogRegistry["zh-CN"]!();

describe("command palette in Simplified Chinese", () => {
  it.each(["unlinked", "linked"] as const)("translates action titles and chrome (%s)", (status) => {
    cloud.status = status;

    const html = renderToStaticMarkup(
      <LanguageProvider testCatalog={{ locale: "zh-CN", catalog: zhCNCatalog }}>
        <CommandPalette>{null}</CommandPalette>
      </LanguageProvider>,
    );

    for (const text of [
      'aria-label="命令面板"',
      'placeholder="搜索命令和聊天..."',
      "切换到浅色模式",
      "切换主题编辑器",
      "打开插件",
      "打开用量",
      zhCNCatalog["Send feedback"],
      zhCNCatalog["Open settings"],
      zhCNCatalog["Actions"],
      status === "unlinked" ? "连接 Akeru Cloud" : "断开 Akeru Cloud",
    ]) {
      expect(html).toContain(text);
    }

    expect(html).not.toContain("Open plugins");
    expect(html).not.toContain("Connect Akeru Cloud");
    expect(html).not.toContain("Disconnect Akeru Cloud");
  });
  it("opens cloud settings for the same environment the palette connects", async () => {
    cloud.status = "unlinked";
    cloud.connect.mockClear();
    useSettingsDialogStore
      .getState()
      .openSettings("connections", null, EnvironmentId.make("other-env"));
    renderToStaticMarkup(
      <LanguageProvider testCatalog={{ locale: "zh-CN", catalog: zhCNCatalog }}>
        <CommandPalette>{null}</CommandPalette>
      </LanguageProvider>,
    );
    expect(cloud.connectAction).toBeDefined();
    await cloud.connectAction?.();
    expect(useSettingsDialogStore.getState().environmentId).toBe("env-test");
    expect(useSettingsDialogStore.getState().section).toBe("akeru-cloud");
    expect(cloud.connect).toHaveBeenCalledOnce();
    useSettingsDialogStore.getState().closeSettings();
  });
});
