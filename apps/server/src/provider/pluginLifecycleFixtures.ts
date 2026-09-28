// @effect-diagnostics nodeBuiltinImport:off
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";

type JsonRpcMessage = {
  readonly id?: unknown;
  readonly method?: string;
  readonly params?: unknown;
};

type FixtureHandler = (params: unknown) => unknown;

const initialize: FixtureHandler = (params) => ({
  protocolVersion:
    typeof params === "object" && params !== null && "protocolVersion" in params
      ? (params as { protocolVersion: string }).protocolVersion
      : "2025-03-26",
  capabilities: { tools: { listChanged: false } },
  serverInfo: { name: "lifecycle-fixture", version: "1.0.0" },
});

const toolsList: FixtureHandler = () => ({
  tools: [
    {
      name: "echo",
      description: "Echo the supplied text.",
      inputSchema: { type: "object", properties: { text: { type: "string" } } },
      annotations: { readOnlyHint: true },
    },
  ],
});

const toolsCall: FixtureHandler = (params) => ({
  content: [
    {
      type: "text",
      text: `echo:${(params as { arguments?: { text?: string } })?.arguments?.text ?? ""}`,
    },
  ],
});

const METHODS: Record<string, FixtureHandler> = {
  initialize,
  "tools/list": toolsList,
  "tools/call": toolsCall,
};

function respond(message: JsonRpcMessage) {
  if (message.id === undefined) return undefined;
  const handler = METHODS[message.method ?? ""];
  if (!handler) {
    return {
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32601, message: "Method not found" },
    };
  }
  return { jsonrpc: "2.0", id: message.id, result: handler(message.params) };
}

export interface HttpMcpFixture {
  readonly url: string;
  readonly close: () => Promise<void>;
}

/**
 * Streamable HTTP MCP server standing in for a vendor endpoint such as
 * `https://mcp.exa.ai/mcp`. Loopback-only; no real vendor traffic.
 */
export async function startHttpMcpFixture(): Promise<HttpMcpFixture> {
  const server = NodeHttp.createServer((request, response) => {
    if (request.method !== "POST") {
      response.writeHead(405).end();
      return;
    }
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      const reply = respond(JSON.parse(body));
      if (reply === undefined) {
        response.writeHead(202).end();
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(reply));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as NodeNet.AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
