import { assert, it } from "@effect/vitest";

import {
  createStageWorkspaceConfig,
  resolveDesktopRuntimeDependencies,
  STAGE_INSTALL_ARGS,
} from "./build-desktop-artifact.ts";

it.layer(NodeServices.layer)("build-desktop-artifact", (it) => {
  it("omits bundled workspace packages from staged desktop dependencies", () => {
    assert.deepStrictEqual(
      resolveDesktopRuntimeDependencies(
        {
          "@effect/platform-node": "catalog:",
          "@akeru/contracts": "workspace:*",
          "@akeru/shared": "workspace:*",
          "@akeru/ssh": "workspace:*",
          "@akeru/tailscale": "workspace:*",
          effect: "catalog:",
          electron: "41.5.0",
        },
        {
          "@effect/platform-node": "4.0.0-beta.59",
          effect: "4.0.0-beta.59",
        },
      ),
      {
        "@effect/platform-node": "4.0.0-beta.59",
        effect: "4.0.0-beta.59",
      },
    );
  });

  it("installs optional native dependencies for the target desktop architecture", () => {
    assert.deepStrictEqual(STAGE_INSTALL_ARGS, ["install", "--prod"]);
    assert.deepStrictEqual(createStageWorkspaceConfig({ platform: "mac", arch: "x64" }), {
      supportedArchitectures: {
        os: ["darwin"],
        cpu: ["x64"],
      },
    });
    assert.deepStrictEqual(createStageWorkspaceConfig({ platform: "linux", arch: "x64" }), {
      supportedArchitectures: {
        os: ["linux"],
        cpu: ["x64"],
        libc: ["glibc"],
      },
    });
    // The Windows app stage only serves the desktop main process; the server
    // sidecar stage is the one that needs Linux natives (below).
    assert.deepStrictEqual(createStageWorkspaceConfig({ platform: "win", arch: "x64" }), {
      supportedArchitectures: {
        os: ["win32"],
        cpu: ["x64"],
      },
    });
    // The server sidecar stage bundles the same-architecture WSL (Linux,
    // glibc) backend, so its install must fetch Linux native optional deps
    // (e.g. ffi-rs) too — and must be hoisted so the tree survives asar
    // packing and runtime extraction without symlinks.
    assert.deepStrictEqual(
      createStageWorkspaceConfig({ platform: "win", arch: "x64", linuxServerBackend: true }),
      {
        supportedArchitectures: {
          os: ["win32", "linux"],
          cpu: ["x64"],
          libc: ["glibc"],
        },
        nodeLinker: "hoisted",
      },
    );
    assert.deepStrictEqual(
      createStageWorkspaceConfig({ platform: "win", arch: "arm64", linuxServerBackend: true }),
      {
        supportedArchitectures: {
          os: ["win32", "linux"],
          cpu: ["arm64"],
          libc: ["glibc"],
        },
        nodeLinker: "hoisted",
      },
    );
    assert.deepStrictEqual(createStageWorkspaceConfig({ platform: "mac", arch: "universal" }), {
      supportedArchitectures: {
        os: ["darwin"],
        cpu: ["arm64", "x64"],
      },
    });
  });
});
import * as NodeServices from "@effect/platform-node/NodeServices";
