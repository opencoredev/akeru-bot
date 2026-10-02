import { sha256 } from "@noble/hashes/sha2";
import JSZip from "jszip";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { importOpenVsxThemeExtension, type OpenVsxThemeExtension } from "./openVsxThemes";
import { getThemeColorsForMode, themeColorToHex } from "./themePalette";
import { ASSET_ROOT } from "./openVsxThemes.test-support";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Open VSX themes", () => {
  it("downloads a verified VSIX, reads JSONC includes, and pairs contributed variants", async () => {
    const zip = new JSZip();
    zip.file("extension/.gitkeep", "");

    // Theme extensions sometimes publish their development dependencies too.
    // Those unused files should not prevent importing the small theme payload.
    for (let index = 0; index < 3_000; index += 1) {
      zip.file(`extension/node_modules/package-${index}.js`, "");
    }

    zip.file(
      "extension/themes/base.jsonc",
      `{
        // inherited workbench colors
        "colors": {
          "editor.foreground": "#eeeeee",
          "focusBorder": "#8b5cf6",
        },
      }`,
    );
    zip.file(
      "extension/themes/demo-dark.json",
      `{
        "include": "./base.jsonc",
        "colors": { "editor.background": "#111111" }
      }`,
    );
    zip.file(
      "extension/themes/demo-light.json",
      `{
        "colors": {
          "editor.background": "#fafafa",
          "editor.foreground": "#222222",
          "focusBorder": "#8b5cf6"
        }
      }`,
    );
    zip.file(
      "extension/themes/demo.json",
      `{
        "colors": {
          "editor.background": "#181818",
          "editor.foreground": "#eeeeee"
        }
      }`,
    );

    const packagedManifest = {
      publisher: "demo",
      name: "theme",
      version: "1.0.0",
      license: "MIT",
      contributes: {
        themes: [
          { label: "Demo Dark", uiTheme: "vs-dark", path: "./themes/demo-dark.json" },
          { label: "Demo Light", uiTheme: "vs", path: "./themes/demo-light.json" },
          { label: "Demo", uiTheme: "vs-dark", path: "./themes/demo.json" },
        ],
      },
    };

    let packageBytes = new ArrayBuffer(0);
    let checksum = "";

    const rebuildPackage = async () => {
      zip.file("extension/package.json", JSON.stringify(packagedManifest));
      packageBytes = await zip.generateAsync({
        type: "arraybuffer",
        comment: `PK\u0005\u0006${"x".repeat(26)}`,
      });
      checksum = [...sha256(new Uint8Array(packageBytes))]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
    };

    await rebuildPackage();

    // The public manifest is only a preflight hint. Imports must use the manifest
    // inside the checksummed VSIX rather than this inconsistent contribution.
    const manifest = {
      contributes: { themes: [{ label: "Wrong", path: "./themes/missing.json" }] },
    };

    const extension: OpenVsxThemeExtension = {
      collectionId: "open-vsx:demo.theme",
      id: "demo.theme",
      name: "Demo Theme",
      publisher: "demo",
      description: "",
      downloadCount: 1,
      iconUrl: null,
      sourceUrl: null,
      license: "MIT",
      manifestUrl: `${ASSET_ROOT}/package.json`,
      sha256Url: `${ASSET_ROOT}/demo.theme-1.0.0.sha256`,
      version: "1.0.0",
      vsixUrl: `${ASSET_ROOT}/demo.theme-1.0.0.vsix`,
    };

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);

        if (url === extension.manifestUrl) {
          return new Response(JSON.stringify(manifest), { status: 200 });
        }

        if (url === extension.sha256Url) return new Response(`${checksum}  demo.vsix`);

        return new Response(packageBytes, {
          status: 200,
          headers: { "Content-Length": String(packageBytes.byteLength) },
        });
      }),
    );

    const themes = await importOpenVsxThemeExtension(extension);

    expect(themes).toHaveLength(2);
    expect(new Set(themes.map((theme) => theme.id)).size).toBe(2);
    expect(themes.every((theme) => /^ovx-[a-z0-9-]+-[0-9a-f]{12}$/.test(theme.id))).toBe(true);
    expect(themes.every((theme) => theme.collection?.id === "open-vsx:demo.theme")).toBe(true);

    const paired = themes.find(
      (theme) =>
        getThemeColorsForMode(theme, "light") !== null &&
        getThemeColorsForMode(theme, "dark") !== null,
    )!;

    expect(paired.label).toBe("Demo");
    expect(themeColorToHex(paired.colors.canvas)).toBe("#fafafa");
    expect(themeColorToHex(getThemeColorsForMode(paired, "dark")!.canvas)).toBe("#111111");
    expect(themeColorToHex(getThemeColorsForMode(paired, "dark")!.text)).toBe("#eeeeee");

    packagedManifest.contributes.themes[0]!.label = "Renamed Dark";
    packagedManifest.contributes.themes[1]!.label = "Renamed Light";
    packagedManifest.contributes.themes[2]!.label = "Renamed Solo";
    await rebuildPackage();
    const renamedThemes = await importOpenVsxThemeExtension(extension);
    expect(renamedThemes.map((theme) => theme.id)).toEqual(themes.map((theme) => theme.id));

    packagedManifest.contributes.themes.push({
      label: "Duplicate Demo",
      uiTheme: "vs-dark",
      path: "./themes/demo.json",
    });
    await rebuildPackage();
    const duplicatePathThemes = await importOpenVsxThemeExtension(extension);
    expect(new Set(duplicatePathThemes.map((theme) => theme.id)).size).toBe(
      duplicatePathThemes.length,
    );
    expect(themes.every(({ id }) => duplicatePathThemes.some((theme) => theme.id === id))).toBe(
      true,
    );
    packagedManifest.contributes.themes.pop();

    packagedManifest.contributes.themes[2]!.path = "./themes/missing.json";
    await rebuildPackage();
    await expect(importOpenVsxThemeExtension(extension)).rejects.toThrow(
      "could not be imported safely",
    );
    packagedManifest.contributes.themes[2]!.path = "./themes/demo.json";

    packagedManifest.license = "Proprietary";
    await rebuildPackage();
    await expect(importOpenVsxThemeExtension(extension)).rejects.toThrow(
      "does not match its advertised license",
    );

    Reflect.deleteProperty(packagedManifest, "license");
    await rebuildPackage();
    await expect(importOpenVsxThemeExtension(extension)).rejects.toThrow(
      "does not match its advertised license",
    );
  });

  it("stops import work when the request is cancelled", async () => {
    const packageBytes = new Uint8Array([1, 2, 3]);

    const checksum = [...sha256(packageBytes)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");

    const controller = new AbortController();

    const extension: OpenVsxThemeExtension = {
      collectionId: "open-vsx:demo.theme",
      id: "demo.theme",
      name: "Demo Theme",
      publisher: "demo",
      description: "",
      downloadCount: 1,
      iconUrl: null,
      sourceUrl: null,
      license: "MIT",
      manifestUrl: `${ASSET_ROOT}/package.json`,
      sha256Url: `${ASSET_ROOT}/demo.theme-1.0.0.sha256`,
      version: "1.0.0",
      vsixUrl: `${ASSET_ROOT}/demo.theme-1.0.0.vsix`,
    };

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);

        if (url === extension.manifestUrl) {
          return new Response(
            JSON.stringify({ contributes: { themes: [{ path: "./theme.json" }] } }),
          );
        }

        if (url === extension.sha256Url) {
          controller.abort();

          return new Response(checksum);
        }

        return new Response(packageBytes);
      }),
    );

    await expect(importOpenVsxThemeExtension(extension, controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
  });

  it("rejects a package whose Open VSX checksum does not match", async () => {
    const extension: OpenVsxThemeExtension = {
      collectionId: "open-vsx:demo.theme",
      id: "demo.theme",
      name: "Demo Theme",
      publisher: "demo",
      description: "",
      downloadCount: 1,
      iconUrl: null,
      sourceUrl: null,
      license: "MIT",
      manifestUrl: `${ASSET_ROOT}/package.json`,
      sha256Url: `${ASSET_ROOT}/demo.theme-1.0.0.sha256`,
      version: "1.0.0",
      vsixUrl: `${ASSET_ROOT}/demo.theme-1.0.0.vsix`,
    };

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);

        if (url === extension.manifestUrl) {
          return new Response(
            JSON.stringify({ contributes: { themes: [{ path: "./theme.json" }] } }),
          );
        }

        if (url === extension.sha256Url) return new Response("0".repeat(64));

        return new Response(new Uint8Array([1, 2, 3]));
      }),
    );

    await expect(importOpenVsxThemeExtension(extension)).rejects.toThrow("integrity check");
  });
});
