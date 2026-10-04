import * as Crypto from "effect/Crypto";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createMcpServer,
  deleteMcpServer,
  disableMcpServer,
  enableMcpServer,
  type CreateMcpServerInput,
  type DeleteMcpServerInput,
  type DisableMcpServerInput,
  type EnableMcpServerInput,
  type UpdateMcpServerInput,
  updateMcpServer,
} from "../operations/commands.ts";
import { createAtomCommandScheduler, createEnvironmentCommand } from "./runtime.ts";

export type {
  CreateMcpServerInput,
  DeleteMcpServerInput,
  DisableMcpServerInput,
  EnableMcpServerInput,
  UpdateMcpServerInput,
} from "../operations/commands.ts";

export function createMcpServerEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | Crypto.Crypto | R, E>,
) {
  const scheduler = createAtomCommandScheduler();

  const concurrency = {
    mode: "serial" as const,
    key: ({ environmentId, input }: { environmentId: string; input: { mcpServerId: string } }) =>
      JSON.stringify([environmentId, input.mcpServerId]),
  };

  return {
    create: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:mcp-server:create",
      execute: (input: CreateMcpServerInput) => createMcpServer(input),
      scheduler,
      concurrency,
    }),
    update: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:mcp-server:update",
      execute: (input: UpdateMcpServerInput) => updateMcpServer(input),
      scheduler,
      concurrency,
    }),
    delete: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:mcp-server:delete",
      execute: (input: DeleteMcpServerInput) => deleteMcpServer(input),
      scheduler,
      concurrency,
    }),
    enable: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:mcp-server:enable",
      execute: (input: EnableMcpServerInput) => enableMcpServer(input),
      scheduler,
      concurrency,
    }),
    disable: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:mcp-server:disable",
      execute: (input: DisableMcpServerInput) => disableMcpServer(input),
      scheduler,
      concurrency,
    }),
  };
}
