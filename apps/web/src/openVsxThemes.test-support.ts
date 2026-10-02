import type * as Schema from "effect/Schema";

export const ASSET_ROOT = "https://open-vsx.org/api/demo/theme/1.0.0/file";

export function extensionDetail(overrides: Schema.JsonObject = {}) {
  return {
    namespace: "demo",
    name: "theme",
    displayName: "Demo Theme",
    description: "A nice theme",
    version: "1.0.0",
    downloadCount: 123456,
    license: "MIT",
    repository: "https://github.com/demo/theme",
    files: {
      icon: `${ASSET_ROOT}/icon.png`,
      manifest: `${ASSET_ROOT}/package.json`,
      sha256: `${ASSET_ROOT}/demo.theme-1.0.0.sha256`,
      download: `${ASSET_ROOT}/demo.theme-1.0.0.vsix`,
    },
    ...overrides,
  };
}
