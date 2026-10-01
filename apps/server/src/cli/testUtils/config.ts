import * as Schema from "effect/Schema";
import {
  DesktopBackendBootstrap,
  type DesktopBackendBootstrap as DesktopBackendBootstrapValue,
} from "@akeru/contracts";
import { deriveServerPaths } from "../../config.ts";

const deriveExplicitServerPaths = (baseDir: string, devUrl: URL | undefined) =>
  deriveServerPaths(baseDir, devUrl, { baseDirIsExplicit: true });

const encodeDesktopBootstrap = Schema.encodeEffect(Schema.fromJsonString(DesktopBackendBootstrap));

const makeDesktopBootstrap = (
  overrides: Partial<DesktopBackendBootstrapValue> = {},
): DesktopBackendBootstrapValue => ({
  mode: "desktop",
  noBrowser: true,
  port: 4888,
  t3Home: "/tmp/t3-bootstrap-home",
  host: "127.0.0.1",
  desktopBootstrapToken: "desktop-bootstrap-token",
  tailscaleServeEnabled: false,
  tailscaleServePort: 443,
  ...overrides,
});
export { deriveExplicitServerPaths, encodeDesktopBootstrap, makeDesktopBootstrap };
