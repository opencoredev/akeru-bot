import { createEnvironmentRpcCommand } from "@akeru/client-runtime/state/runtime";
import { WS_METHODS } from "@akeru/contracts";

import { connectionAtomRuntime } from "../connection/runtime";

export const portabilityEnvironment = {
  exportArchive: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "web:portability:export",
    tag: WS_METHODS.portabilityExport,
  }),
  previewImport: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "web:portability:preview-import",
    tag: WS_METHODS.portabilityPreviewImport,
  }),
  applyImport: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "web:portability:apply-import",
    tag: WS_METHODS.portabilityApplyImport,
  }),
};
