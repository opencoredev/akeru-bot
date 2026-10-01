# Terminal font preview renderer

Akeru no longer has a user terminal. The web terminal drawer, the mobile terminal screen, the Android
renderer, and the server's PTY sessions are gone. One piece of the old renderer remains: the web
settings page draws its terminal font preview with the Ghostty canvas renderer in
`apps/web/src/terminal/ghostty`.

## What remains

`TerminalFontPreview` in `apps/web/src/components/settings/SettingsFontPreviews.tsx` creates a
`GhosttyTerminalSurface` against a local echo loop, not a server session. It shows the selected
monospace family and size so the preview matches how the renderer lays out glyphs. Nothing crosses
the wire.

The web adapter uses the official `libghostty-vt` C ABI for parsing, terminal state, grapheme
boundaries, and keyboard encoding. It loads a separately cached WebAssembly build and reads render
state into a Canvas 2D surface. The adapter owns browser font shaping, input, and the Canvas
renderer. React does not participate in terminal frames. The runtime is singleton-scoped per browser
tab, and each surface frees its own Ghostty handles when it unmounts.

## Updating Ghostty

The upstream pin and license live in `native/libghostty-vt/` at the repository root. After changing
`native/libghostty-vt/VERSION`, run:

```sh
pnpm --dir apps/web build:ghostty-wasm
```

Commit the regenerated web `wasm` artifacts. The build embeds the pinned revision into the binary
as semver build metadata. The focused web ABI test reads it back through `ghostty_build_info` and
compares it with `VERSION`, so the vendor directory holds only artifacts and there is no second pin
to keep in sync. The same test enforces the artifact budget and exercises repeated
create/write/free cycles with multi-codepoint graphemes.
