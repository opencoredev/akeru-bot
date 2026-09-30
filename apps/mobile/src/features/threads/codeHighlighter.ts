import { createHighlighterCore, type HighlighterCore } from "@shikijs/core";
import { createJavaScriptRegexEngine } from "@shikijs/engine-javascript";
import bashLanguage from "@shikijs/langs/bash";
import javascriptLanguage from "@shikijs/langs/javascript";
import jsonLanguage from "@shikijs/langs/json";
import jsxLanguage from "@shikijs/langs/jsx";
import tsxLanguage from "@shikijs/langs/tsx";
import typescriptLanguage from "@shikijs/langs/typescript";
import yamlLanguage from "@shikijs/langs/yaml";
import githubDarkDefault from "@shikijs/themes/github-dark-default";
import githubLightDefault from "@shikijs/themes/github-light-default";

export type CodeHighlightTheme = "light" | "dark";

export interface HighlightedCodeToken {
  readonly content: string;
  readonly color: string | null;
  readonly fontStyle: number | null;
}

const SHIKI_THEME_NAME_BY_SCHEME = {
  light: "github-light-default",
  dark: "github-dark-default",
} as const;
// Tests always use the JavaScript regex engine; apps prefer the native one when present.
const PREFER_NATIVE_ENGINE =
  (process.env.EXPO_PUBLIC_CODE_HIGHLIGHTER_ENGINE ??
    (process.env.NODE_ENV === "test" ? "javascript" : "native")) === "native";
const HIGHLIGHT_CHUNK_LINE_THRESHOLD = 8;
const HIGHLIGHT_CHUNK_SIZE = 200;
const TOKENIZE_MAX_LINE_LENGTH = 1_000;
const INITIAL_LANGUAGE_MODULES = [
  bashLanguage,
  javascriptLanguage,
  jsonLanguage,
  jsxLanguage,
  tsxLanguage,
  typescriptLanguage,
  yamlLanguage,
] satisfies Parameters<typeof createHighlighterCore>[0]["langs"];
const loadedLanguages = new Set<string>([
  "text",
  "bash",
  "javascript",
  "json",
  "jsx",
  "tsx",
  "typescript",
  "yaml",
]);
const languageLoadingPromises = new Map<string, Promise<boolean>>();
const languageImports: Partial<Record<string, () => Promise<unknown>>> = {
  javascript: () => import("@shikijs/langs/javascript"),
  typescript: () => import("@shikijs/langs/typescript"),
  jsx: () => import("@shikijs/langs/jsx"),
  tsx: () => import("@shikijs/langs/tsx"),
  python: () => import("@shikijs/langs/python"),
  rust: () => import("@shikijs/langs/rust"),
  go: () => import("@shikijs/langs/go"),
  java: () => import("@shikijs/langs/java"),
  kotlin: () => import("@shikijs/langs/kotlin"),
  swift: () => import("@shikijs/langs/swift"),
  "objective-c": () => import("@shikijs/langs/objective-c"),
  c: () => import("@shikijs/langs/c"),
  cpp: () => import("@shikijs/langs/cpp"),
  csharp: () => import("@shikijs/langs/csharp"),
  php: () => import("@shikijs/langs/php"),
  ruby: () => import("@shikijs/langs/ruby"),
  lua: () => import("@shikijs/langs/lua"),
  perl: () => import("@shikijs/langs/perl"),
  r: () => import("@shikijs/langs/r"),
  dart: () => import("@shikijs/langs/dart"),
  scala: () => import("@shikijs/langs/scala"),
  elixir: () => import("@shikijs/langs/elixir"),
  haskell: () => import("@shikijs/langs/haskell"),
  clojure: () => import("@shikijs/langs/clojure"),
  ocaml: () => import("@shikijs/langs/ocaml"),
  fsharp: () => import("@shikijs/langs/fsharp"),
  erlang: () => import("@shikijs/langs/erlang"),
  zig: () => import("@shikijs/langs/zig"),
  nim: () => import("@shikijs/langs/nim"),
  html: () => import("@shikijs/langs/html"),
  css: () => import("@shikijs/langs/css"),
  scss: () => import("@shikijs/langs/scss"),
  less: () => import("@shikijs/langs/less"),
  xml: () => import("@shikijs/langs/xml"),
  svg: () => import("@shikijs/langs/xml"),
  vue: () => import("@shikijs/langs/vue"),
  svelte: () => import("@shikijs/langs/svelte"),
  astro: () => import("@shikijs/langs/astro"),
  json: () => import("@shikijs/langs/json"),
  jsonc: () => import("@shikijs/langs/jsonc"),
  yaml: () => import("@shikijs/langs/yaml"),
  toml: () => import("@shikijs/langs/toml"),
  ini: () => import("@shikijs/langs/ini"),
  bash: () => import("@shikijs/langs/bash"),
  shellscript: () => import("@shikijs/langs/shellscript"),
  powershell: () => import("@shikijs/langs/powershell"),
  fish: () => import("@shikijs/langs/fish"),
  sql: () => import("@shikijs/langs/sql"),
  graphql: () => import("@shikijs/langs/graphql"),
  prisma: () => import("@shikijs/langs/prisma"),
  docker: () => import("@shikijs/langs/docker"),
  hcl: () => import("@shikijs/langs/hcl"),
  nix: () => import("@shikijs/langs/nix"),
  markdown: () => import("@shikijs/langs/markdown"),
  mdx: () => import("@shikijs/langs/mdx"),
  tex: () => import("@shikijs/langs/tex"),
  diff: () => import("@shikijs/langs/diff"),
  regex: () => import("@shikijs/langs/regex"),
  viml: () => import("@shikijs/langs/viml"),
  makefile: () => import("@shikijs/langs/makefile"),
  cmake: () => import("@shikijs/langs/cmake"),
  groovy: () => import("@shikijs/langs/groovy"),
};

const languageAliases: Record<string, string> = {
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  py: "python",
  rb: "ruby",
  rs: "rust",
  sh: "bash",
  zsh: "bash",
  shell: "shellscript",
  yml: "yaml",
  md: "markdown",
  "c++": "cpp",
  "c#": "csharp",
  cs: "csharp",
  dockerfile: "docker",
  vim: "viml",
  objc: "objective-c",
  objectivec: "objective-c",
  "obj-c": "objective-c",
  ps1: "powershell",
  pwsh: "powershell",
  hs: "haskell",
  ex: "elixir",
  exs: "elixir",
  erl: "erlang",
  clj: "clojure",
  ml: "ocaml",
  fs: "fsharp",
  tf: "hcl",
  make: "makefile",
  plain: "text",
  plaintext: "text",
  txt: "text",
};
let highlighterPromise: Promise<HighlighterCore> | null = null;

type LoadedLanguageModule = {
  default: Parameters<HighlighterCore["loadLanguage"]>[0];
};

function waitForNextFrame(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

async function createHighlighter(): Promise<HighlighterCore> {
  const themes = [githubLightDefault, githubDarkDefault];
  if (PREFER_NATIVE_ENGINE) {
    try {
      const nativeEngineModule = await import("react-native-shiki-engine");
      if (nativeEngineModule.isNativeEngineAvailable()) {
        return await createHighlighterCore({
          themes,
          langs: INITIAL_LANGUAGE_MODULES,
          engine: nativeEngineModule.createNativeEngine(),
        });
      }
    } catch {
      // Fall back to the JavaScript regex engine below.
    }
  }
  return createHighlighterCore({
    themes,
    langs: INITIAL_LANGUAGE_MODULES,
    engine: createJavaScriptRegexEngine(),
  });
}

function getHighlighter(): Promise<HighlighterCore> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter().catch((error) => {
      highlighterPromise = null;
      throw error;
    });
  }
  return highlighterPromise;
}

function resolveLanguageAlias(language: string): string {
  const normalized = language.toLowerCase();
  return languageAliases[normalized] ?? normalized;
}

async function loadSingleLanguage(
  highlighter: HighlighterCore,
  language: string,
): Promise<boolean> {
  if (loadedLanguages.has(language)) {
    return true;
  }

  const existingPromise = languageLoadingPromises.get(language);
  if (existingPromise) {
    return existingPromise;
  }

  const importer = languageImports[language];
  if (!importer) {
    return false;
  }

  const loadingPromise = (async () => {
    try {
      const languageModule = (await importer()) as LoadedLanguageModule;
      await highlighter.loadLanguage(languageModule.default);
      loadedLanguages.add(language);
      return true;
    } catch {
      return false;
    } finally {
      languageLoadingPromises.delete(language);
    }
  })();

  languageLoadingPromises.set(language, loadingPromise);
  return loadingPromise;
}

async function resolveLanguage(languageHint: string): Promise<string> {
  const candidate = resolveLanguageAlias(languageHint);
  if (candidate === "text" || candidate === "ansi" || !(candidate in languageImports)) {
    return "text";
  }
  if (loadedLanguages.has(candidate)) {
    return candidate;
  }
  const loaded = await loadSingleLanguage(await getHighlighter(), candidate);
  return loaded ? candidate : "text";
}

function normalizeHighlightedLines(
  tokenLines: ReadonlyArray<ReadonlyArray<{ content: string; color?: string; fontStyle?: number }>>,
): ReadonlyArray<ReadonlyArray<HighlightedCodeToken>> {
  return tokenLines.map((line) =>
    line.map((token) => ({
      content: token.content,
      color: token.color ?? null,
      fontStyle: token.fontStyle ?? null,
    })),
  );
}

async function highlightLines(
  code: string,
  language: string,
  theme: string,
): Promise<ReadonlyArray<ReadonlyArray<HighlightedCodeToken>>> {
  if (code.length === 0) {
    return [];
  }

  const highlighter = await getHighlighter();
  const sourceLines = code.split("\n");
  const highlightedLines: Array<ReadonlyArray<HighlightedCodeToken>> = [];
  const shortLineBatch: string[] = [];

  const flushShortLineBatch = async (): Promise<void> => {
    if (shortLineBatch.length === 0) {
      return;
    }

    const tokenLines = highlighter.codeToTokensBase(shortLineBatch.join("\n"), {
      lang: language,
      theme,
    });
    highlightedLines.push(...normalizeHighlightedLines(tokenLines));
    shortLineBatch.length = 0;
  };

  for (let lineIndex = 0; lineIndex < sourceLines.length; lineIndex += 1) {
    const line = sourceLines[lineIndex] ?? "";

    if (line.length > TOKENIZE_MAX_LINE_LENGTH) {
      await flushShortLineBatch();
      highlightedLines.push([{ content: line, color: null, fontStyle: null }]);
    } else {
      shortLineBatch.push(line);
    }

    if (shortLineBatch.length >= HIGHLIGHT_CHUNK_SIZE) {
      await flushShortLineBatch();
    }

    if (
      sourceLines.length > HIGHLIGHT_CHUNK_LINE_THRESHOLD &&
      lineIndex + 1 < sourceLines.length &&
      (shortLineBatch.length === 0 || line.length > TOKENIZE_MAX_LINE_LENGTH)
    ) {
      await waitForNextFrame();
    }
  }

  await flushShortLineBatch();

  return highlightedLines;
}

/** Tokenizes a fenced code block from chat markdown. Unknown languages render as plain text. */
export async function highlightCodeSnippet(input: {
  readonly code: string;
  readonly language?: string | null;
  readonly theme: CodeHighlightTheme;
}): Promise<ReadonlyArray<ReadonlyArray<HighlightedCodeToken>>> {
  const language = await resolveLanguage(input.language?.trim() || "text");
  return highlightLines(input.code, language, SHIKI_THEME_NAME_BY_SCHEME[input.theme]);
}
