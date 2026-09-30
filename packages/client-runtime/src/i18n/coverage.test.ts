import { describe, expect, it } from "vite-plus/test";

import { englishCatalog, validateCatalog } from "./index.ts";

type DirectoryEntry = {
  name: string;
  isDirectory(): boolean;
};
type NodeFs = {
  readFileSync(path: URL, encoding: "utf8"): string;
  readdirSync(path: URL, options: { withFileTypes: true }): DirectoryEntry[];
};

const { readFileSync, readdirSync } = (
  globalThis as typeof globalThis & {
    process: { getBuiltinModule(id: "fs"): NodeFs };
  }
).process.getBuiltinModule("fs");

const root = new URL("../../../../", import.meta.url);
const read = (file: string) => readFileSync(new URL(file, root), "utf8");

function discover(directory: string): string[] {
  return readdirSync(new URL(directory, root), { withFileTypes: true }).flatMap((entry) => {
    const file = `${directory}/${entry.name}`;
    if (entry.isDirectory()) return discover(file);
    if (!/\.tsx?$/.test(file) || /\.(test|spec)\./.test(file)) return [];
    return /import[\s\S]*?\b(?:useMobileI18n|useI18n)\b[^;]*from/.test(read(file)) ? [file] : [];
  });
}

// Direct double-quoted calls are extracted; every other expression is reported, never assumed covered.
function extract(source: string) {
  const messages: string[] = [];
  const expressions: string[] = [];
  const parameterIssues: string[] = [];
  for (const call of source.matchAll(/\b(?:t|translate)\(\s*/g)) {
    const argument = source.slice(call.index + call[0].length);
    const literal = /^("(?:[^"\\]|\\.)*")\s*[,)]/.exec(argument);
    if (literal?.[1]) {
      const message = JSON.parse(literal[1]) as string;
      messages.push(message);
      const required = [
        ...new Set(Array.from(message.matchAll(/\{(\w+)\}/g), (match) => match[1])),
      ].sort();
      if (required.length) {
        const object = /^\s*\{([^}]*)\}/.exec(argument.slice(literal[0].length));
        const supplied =
          object?.[1]
            ?.split(",")
            .map((field) => /^\s*(\w+)/.exec(field)?.[1])
            .filter(Boolean)
            .sort() ?? [];
        if (JSON.stringify(required) !== JSON.stringify(supplied)) parameterIssues.push(message);
      }
    } else expressions.push(argument.split("\n")[0]?.trim() ?? "");
  }
  // Plural forms are catalog copy too; the count parameter is supplied by plural itself.
  for (const call of source.matchAll(/\bplural\(/g)) {
    const forms =
      /^[^{]*(\{[\s\S]*?\})\s*[,)]/.exec(source.slice(call.index + call[0].length))?.[1] ?? "";
    messages.push(...literals(forms, /\b(?:zero|one|two|few|many|other):\s*("(?:[^"\\]|\\.)*")/g));
  }
  return { messages, expressions, parameterIssues };
}

function between(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  if (from < 0 || to < 0) throw new Error(`Missing extraction boundary: ${start} / ${end}`);
  return source.slice(from + start.length, to);
}

function literals(source: string, pattern: RegExp): string[] {
  return Array.from(source.matchAll(pattern), (match) => JSON.parse(match[1] ?? '""') as string);
}

function finiteLabelSources(): Record<string, string[]> {
  const settings = read("apps/web/src/components/settings/settingsSearch.ts");
  const dialog = read("apps/web/src/components/settings/SettingsDialog.tsx");
  const pairing = read("apps/web/src/components/auth/PairingRouteSurface.tsx");
  const dictation = read("apps/mobile/src/components/DictationControls.tsx");
  return {
    "SettingsDialog: item.title (SETTINGS_SEARCH_ITEMS)": literals(
      between(settings, "export const SETTINGS_SEARCH_ITEMS = [", "] as const"),
      /\btitle:\s*("(?:[^"\\]|\\.)*")/g,
    ),
    "SettingsDialog: group.label and item.label (SETTINGS_NAV_GROUPS)": literals(
      between(dialog, "export const SETTINGS_NAV_GROUPS:", "\n];"),
      /\blabel:\s*("(?:[^"\\]|\\.)*")/g,
    ),
    "PairingRouteSurface: describeAuthGate / describeSupportedMethods": literals(
      pairing.slice(pairing.indexOf("function describeAuthGate(")),
      /\breturn\s*("(?:[^"\\]|\\.)*")/g,
    ),
    "DictationControls (mobile): announcements[status]": literals(
      between(dictation, "const announcements = {", "\n};"),
      /:\s*("(?:[^"\\]|\\.)*")/g,
    ),
  };
}

describe("discovered interface message coverage", () => {
  it("does not classify expressions or concatenations as extracted messages", () => {
    expect(
      extract('t("Settings");\nt(item.label);\nt(`Hello ${name}`);\nt("prefix" + suffix)'),
    ).toEqual({
      messages: ["Settings"],
      expressions: ["item.label);", "`Hello ${name}`);", '"prefix" + suffix)'],
      parameterIssues: [],
    });
  });

  it("extracts every plural form as a message", () => {
    expect(
      extract('plural(count, { one: "{count} bot", other: "{count} bots" })').messages,
    ).toEqual(["{count} bot", "{count} bots"]);
  });

  it("checks named parameters without interpreting supplied user content", () => {
    expect(extract('t("Use {language}", { language: option.label })').parameterIssues).toEqual([]);
    expect(extract('t("Reset {label}", { label })').parameterIssues).toEqual([]);
    expect(extract('t("Use {language}", { name: option.label })').parameterIssues).toEqual([
      "Use {language}",
    ]);
    expect(extract('t("Use {language}")').parameterIssues).toEqual(["Use {language}"]);
  });

  it("covers static calls and finite label sources without translating identifiers", () => {
    const surfaces = [
      ...discover("apps/mobile/src"),
      ...discover("apps/web/src"),
      "apps/web/src/components/CommandPalette.logic.ts",
      "apps/web/src/components/chat/composerProviderMenuItems.ts",
      "apps/mobile/src/features/updates/app-updates.ts",
      "apps/web/src/components/onboarding/desktopOnboarding.logic.ts",
      "apps/web/src/components/onboarding/goalPlan.logic.ts",
      "packages/client-runtime/src/botInbox.ts",
      "packages/client-runtime/src/channelPresentation.ts",
      "packages/client-runtime/src/durableMemory.ts",
      "packages/client-runtime/src/errors/threadErrorPresentation.ts",
      "packages/client-runtime/src/imageGeneration.ts",
      "packages/client-runtime/src/providerAccessGuide.ts",
      "packages/client-runtime/src/providerAvailability.ts",
      "apps/web/src/components/roster/botEngineSelection.ts",
      "apps/web/src/components/roster/routineReceipts.ts",
      "apps/web/src/components/settings/SettingsPanels.logic.ts",
    ].sort();
    const missing: string[] = [];
    const expressions: Record<string, string[]> = {};
    const directMessages = new Set<string>();
    for (const file of surfaces) {
      const result = extract(read(file));
      expect(result.parameterIssues, `${file}: named parameter coverage`).toEqual([]);
      for (const message of result.messages) {
        directMessages.add(message);
        if (!Object.hasOwn(englishCatalog, message)) missing.push(`${file}: ${message}`);
      }
      if (result.expressions.length) expressions[file] = result.expressions;
    }
    const finiteSources = finiteLabelSources();
    for (const [source, messages] of Object.entries(finiteSources)) {
      expect(messages.length, source).toBeGreaterThan(0);
      for (const message of messages) {
        if (!Object.hasOwn(englishCatalog, message)) missing.push(`${source}: ${message}`);
      }
    }
    expect(missing).toEqual([]);
    expect(validateCatalog(englishCatalog)).toEqual([]);
    // An inventory, not an exemption: all expressions remain visible even when their sources are enumerated above.
    expect({
      surfaces,
      directMessageCount: directMessages.size,
      expressions,
      finiteSources,
    }).toMatchSnapshot();
    expect(Object.hasOwn(englishCatalog, "desktop-bootstrap")).toBe(false);
    expect(Object.hasOwn(englishCatalog, "/settings/general")).toBe(false);
  });
});
