import type { McpServerId, McpServerConfiguration } from "@t3tools/contracts";

import type { PluginTogglePlan } from "./pluginRegistry";

interface PluginEnableOperations {
  readonly create: (
    mcpServerId: McpServerId,
    configuration: McpServerConfiguration,
  ) => Promise<boolean>;
  readonly update: (
    mcpServerId: McpServerId,
    configuration: McpServerConfiguration,
  ) => Promise<boolean>;
  readonly enable: (mcpServerId: McpServerId) => Promise<boolean>;
  readonly authenticate?: (
    mcpServerId: McpServerId,
    onAuthorizationUrl: (url: string) => Promise<void>,
  ) => Promise<boolean>;
  readonly openAuthorizationUrl: (url: string) => Promise<void>;
}

export async function runPluginEnablePlan(
  plan: Exclude<PluginTogglePlan, { readonly action: "disable" }>,
  operations: PluginEnableOperations,
): Promise<boolean> {
  if (plan.action === "create") {
    if (!(await operations.create(plan.mcpServerId, plan.configuration))) return false;
  } else {
    if (!(await operations.update(plan.mcpServerId, plan.configuration))) return false;
    if (!(await operations.enable(plan.mcpServerId))) return false;
  }

  return operations.authenticate
    ? operations.authenticate(plan.mcpServerId, operations.openAuthorizationUrl)
    : true;
}
