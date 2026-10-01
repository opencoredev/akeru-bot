import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { expect } from "vite-plus/test";

it.effect("maps terminal scrollbar roles without recoloring ordinary scrollbars", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const css = yield* fileSystem.readFileString(
      decodeURIComponent(new URL("./index.css", import.meta.url).pathname),
    );

    expect(css).toContain("--terminal-scrollbar: var(--app-scrollbar-thumb)");
    expect(css).toContain("--terminal-scrollbar-hover: var(--app-scrollbar-thumb-hover)");
    expect(css).toContain("--terminal-scrollbar: var(--app-theme-terminal-scrollbar)");
    expect(css).toContain("--terminal-scrollbar-hover: var(--app-theme-terminal-scrollbar-hover)");
    expect(css).toContain("background: var(--terminal-scrollbar)");
    expect(css).toContain("background: var(--terminal-scrollbar-hover)");
    expect(css).toContain("background: var(--app-scrollbar-thumb)");
    expect(css).not.toContain("--app-scrollbar-thumb: var(--app-theme-terminal-scrollbar)");
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("keeps long-lived status labels and skeletons static", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const css = yield* fileSystem.readFileString(
      decodeURIComponent(new URL("./index.css", import.meta.url).pathname),
    );

    expect(css).toContain("--animate-skeleton: none");
    expect(css).not.toContain("animation: bot-status-shimmer");
    expect(css).not.toContain("animation: bot-shimmer-sheen");
  }).pipe(Effect.provide(NodeServices.layer)),
);
