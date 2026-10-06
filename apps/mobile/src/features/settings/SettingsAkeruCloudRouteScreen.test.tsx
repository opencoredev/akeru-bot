import { isValidElement, type ReactNode } from "react";
import * as Cause from "effect/Cause";
import { EnvironmentId } from "@akeru/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  alert: vi.fn(),
  command: vi.fn(),
  linked: false,
  linking: false,
  openURL: vi.fn(),
}));

vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: () => [false, vi.fn()],
}));

vi.mock("react-native", () => ({
  Alert: { alert: state.alert },
  Linking: { openURL: state.openURL },
  Platform: { OS: "ios" },
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  View: "View",
}));

vi.mock("@react-navigation/native", () => ({ useNavigation: () => ({ goBack: vi.fn() }) }));

vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));

vi.mock("../../components/AndroidScreenHeader", () => ({ AndroidScreenHeader: "Header" }));

vi.mock("../../components/AppText", () => ({ AppText: "Text" }));

vi.mock("../../native/StackHeader", () => ({ NativeStackScreenOptions: "Options" }));

vi.mock("./components/SettingsSection", () => ({ SettingsSection: "Section" }));

vi.mock("../../state/server", () => ({ serverEnvironment: { cloudStatus: vi.fn() } }));

vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.command }));

vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({
    data: state.linking
      ? {
          status: "linking",
          userCode: "ABCD-EFGH",
          verificationUrl: "https://cloud.test/link",
          expiresAt: "2026-10-05",
        }
      : state.linked
        ? {
            status: "linked",
            account: { email: "leo@test.com" },
            connection: "connected",
            environmentId: "env_1",
          }
        : { status: "unlinked" },
  }),
}));

import { SettingsAkeruCloudRouteScreen } from "./SettingsAkeruCloudRouteScreen";

function findAction(node: ReactNode, label: string): (() => void) | undefined {
  if (Array.isArray(node)) return node.map((child) => findAction(child, label)).find(Boolean);

  if (!isValidElement<{ label?: string; onPress?: () => void; children?: ReactNode }>(node)) return;
  const element = node;

  return element.props.label === label
    ? element.props.onPress
    : findAction(element.props.children, label);
}

const render = () =>
  SettingsAkeruCloudRouteScreen({
    route: { params: { environmentId: EnvironmentId.make("env_1") } },
  });

describe("mobile cloud action errors", () => {
  it.each([false, true])("reports failed cloud actions (linked=%s)", async (linked) => {
    state.alert.mockClear();
    state.command.mockClear();
    state.linked = linked;
    state.linking = false;
    state.command.mockResolvedValue({
      _tag: "Failure",
      cause: Cause.fail(new Error("Cloud unreachable")),
    });
    const action = findAction(render(), linked ? "Disconnect" : "Connect Akeru Cloud");
    expect(action).toBeDefined();
    action?.();

    if (linked) {
      const buttons = state.alert.mock.calls[0]?.[2];
      buttons[1].onPress();
      state.alert.mockClear();
    }

    await state.command.mock.results[0]?.value;
    expect(state.alert).toHaveBeenCalledWith("Akeru Cloud", "Cloud unreachable");
  });
  it("does not alert for an interrupted command", async () => {
    state.alert.mockClear();
    state.command.mockClear();
    state.linked = false;
    state.command.mockResolvedValue({ _tag: "Failure", cause: Cause.interrupt(1) });
    findAction(render(), "Connect Akeru Cloud")?.();
    await state.command.mock.results[0]?.value;
    expect(state.alert).not.toHaveBeenCalled();
  });
  it("shows guidance when an app link has no environment parameters", () => {
    const screen = SettingsAkeruCloudRouteScreen({ route: { params: undefined } });
    expect(JSON.stringify(screen)).toContain("Open Akeru Cloud from Settings for the environment");
  });

  it("reports verification page opening failures", async () => {
    state.alert.mockClear();
    state.linking = true;
    state.openURL.mockRejectedValueOnce(new Error("No browser available"));
    findAction(render(), "Open Akeru Cloud")?.();
    await state.openURL.mock.results.at(-1)?.value.catch(() => undefined);
    expect(state.alert).toHaveBeenCalledWith("Akeru Cloud", "No browser available");
    state.linking = false;
  });
});
