import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { renderToStaticMarkup } from "react-dom/server";
import { AsyncResult } from "effect/unstable/reactivity";
import type { ReactNode } from "react";

const mocks = vi.hoisted(() => ({
  preferences: {} as unknown,
  result: {} as unknown,
  save: vi.fn(),
  buttons: [] as Array<{ accessibilityLabel: string; disabled: boolean; onPress: () => void }>,
}));

vi.mock("../../state/preferences", () => ({
  mobilePreferencesAtom: "preferences",
  updateMobilePreferencesAtom: "update",
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: string) => (atom === "preferences" ? mocks.preferences : mocks.result),
  useAtomSet: () => mocks.save,
}));
vi.mock("react-native", () => ({
  AppState: { addEventListener: () => ({ remove: vi.fn() }) },
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Pressable: (props: {
    children: ReactNode;
    accessibilityLabel: string;
    accessibilityRole: string;
    accessibilityHint: string;
    accessibilityState: { checked: boolean; disabled: boolean };
    disabled: boolean;
    onPress: () => void;
  }) => {
    mocks.buttons.push(props);
    return (
      <button
        role={props.accessibilityRole}
        aria-label={props.accessibilityLabel}
        aria-description={props.accessibilityHint}
        aria-checked={props.accessibilityState.checked}
        disabled={props.disabled}
      >
        {props.children}
      </button>
    );
  },
}));
vi.mock("../../components/AppText", () => ({
  AppText: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));
vi.mock("./components/SettingsSection", () => ({
  SettingsSection: ({ title, children }: { title: string; children: ReactNode }) => (
    <section aria-label={title}>{children}</section>
  ),
}));

import { MobileLanguageProvider } from "../../lib/i18n";
import { LanguageSettingsSection } from "./LanguageSettingsSection";

function renderSelector() {
  return renderToStaticMarkup(
    <MobileLanguageProvider>
      <LanguageSettingsSection />
    </MobileLanguageProvider>,
  );
}

describe("mobile language selector", () => {
  beforeEach(() => {
    mocks.preferences = AsyncResult.success({});
    mocks.result = AsyncResult.initial();
    mocks.save.mockClear();
    mocks.buttons.length = 0;
  });

  it("offers accessible system reset, English, and Simplified Chinese choices", () => {
    const markup = renderSelector();
    expect(markup).toContain('aria-label="Language"');
    expect(markup).toContain('aria-label="System default"');
    expect(markup).toContain('aria-label="English"');
    expect(markup).toContain('aria-label="简体中文"');
    expect(markup).toContain('role="radio"');
    expect(markup).toContain('aria-checked="true"');
    expect(mocks.buttons.map((button) => button.accessibilityLabel)).toEqual([
      "System default",
      "English",
      "简体中文",
    ]);
    mocks.buttons[1]?.onPress();
    expect(mocks.save).toHaveBeenLastCalledWith({ language: "en" });
    mocks.buttons[0]?.onPress();
    expect(mocks.save).toHaveBeenLastCalledWith({ language: "system" });
  });

  it("renders the persisted English selection on a fresh mount", () => {
    mocks.preferences = AsyncResult.success({ language: "en" });
    expect(renderSelector()).toContain(
      'aria-label="English" aria-description="Use English" aria-checked="true"',
    );
  });

  it("disables changes until local preferences load", () => {
    mocks.preferences = AsyncResult.initial();
    renderSelector();
    expect(mocks.buttons.every((button) => button.disabled)).toBe(true);
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("shows persistence failures rather than claiming a successful save", () => {
    mocks.result = AsyncResult.fail("storage unavailable");
    expect(renderSelector()).toContain("Could not save preferences. Try again.");
  });
});
