import type { McpServer } from "@t3tools/contracts";
import type * as EffectAcpSchema from "effect-acp/schema";

const runtimeHeaders = new WeakMap<McpServer, Readonly<Record<string, string>>>();

export function withMcpRuntimeHeaders<T extends McpServer>(
  server: T,
  headers: Readonly<Record<string, string>>,
): T {
  runtimeHeaders.set(server, headers);
  return server;
}

export function getMcpRuntimeHeaders(server: McpServer): Readonly<Record<string, string>> {
  return runtimeHeaders.get(server) ?? {};
}

function sameHeaders(left: McpServer, right: McpServer): boolean {
  const leftHeaders = getMcpRuntimeHeaders(left);
  const rightHeaders = getMcpRuntimeHeaders(right);
  const names = Object.keys(leftHeaders);
  return (
    names.length === Object.keys(rightHeaders).length &&
    names.every((name) => leftHeaders[name] === rightHeaders[name])
  );
}

function sameServer(left: McpServer, right: McpServer): boolean {
  if (
    left.id !== right.id ||
    left.name !== right.name ||
    left.transport !== right.transport ||
    !sameHeaders(left, right)
  ) {
    return false;
  }
  if (left.transport === "url" && right.transport === "url") return left.url === right.url;
  if (left.transport !== "stdio" || right.transport !== "stdio") return false;
  const leftArgs = left.args ?? [];
  const rightArgs = right.args ?? [];
  return (
    left.command === right.command &&
    leftArgs.length === rightArgs.length &&
    leftArgs.every((argument, index) => argument === rightArgs[index])
  );
}

export function sameMcpServerConfigurations(
  left: readonly McpServer[],
  right: readonly McpServer[],
): boolean {
  if (left.length !== right.length) return false;
  return left.every((server) => {
    const other = right.find((candidate) => candidate.id === server.id);
    return other !== undefined && sameServer(server, other);
  });
}

export function toAcpMcpServers(
  servers: readonly McpServer[],
): ReadonlyArray<EffectAcpSchema.McpServer> {
  return servers.map((server) =>
    server.transport === "url"
      ? {
          type: "http" as const,
          name: server.name,
          url: server.url,
          headers: Object.entries(getMcpRuntimeHeaders(server)).map(([name, value]) => ({
            name,
            value,
          })),
        }
      : {
          name: server.name,
          command: server.command,
          args: [...(server.args ?? [])],
          env: [],
        },
  );
}

export function toClaudeMcpServers(servers: readonly McpServer[]) {
  return Object.fromEntries(
    servers.map((server) => [
      String(server.id),
      server.transport === "url"
        ? { type: "http" as const, url: server.url, headers: getMcpRuntimeHeaders(server) }
        : {
            type: "stdio" as const,
            command: server.command,
            args: [...(server.args ?? [])],
          },
    ]),
  );
}
