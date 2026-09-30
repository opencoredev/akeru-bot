import { createMcpServerEnvironmentAtoms } from "@akeru/client-runtime/state/mcp-servers";
import type { EnvironmentId, McpServer } from "@akeru/contracts";
import { Atom } from "effect/unstable/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { environmentSnapshotAtom } from "./shell";

const EMPTY_MCP_SERVERS: ReadonlyArray<McpServer> = Object.freeze([]);

export const mcpServerEnvironment = createMcpServerEnvironmentAtoms(connectionAtomRuntime);

export const environmentMcpServersAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make(
    (get): ReadonlyArray<McpServer> =>
      get(environmentSnapshotAtom(environmentId))?.mcpServers ?? EMPTY_MCP_SERVERS,
  ).pipe(Atom.withLabel(`web-mcp-servers:${environmentId}`)),
);
