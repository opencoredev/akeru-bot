// Stdio MCP server fixture standing in for a local CLI such as `executor mcp`
// or `akeru-codex-computer-use mcp`. Speaks newline-delimited JSON-RPC.
process.stdin.resume();
let buffer = "";
const initialize = (params) => ({
  protocolVersion: params?.protocolVersion ?? "2025-03-26",
  capabilities: { tools: { listChanged: false } },
  serverInfo: { name: "lifecycle-stdio-fixture", version: "1.0.0" },
});
const methods = {
  initialize,
  "tools/list": () => ({
    tools: [
      {
        name: "echo",
        description: "Echo the supplied text.",
        inputSchema: { type: "object", properties: { text: { type: "string" } } },
        annotations: { readOnlyHint: true },
      },
    ],
  }),
  "tools/call": (params) => ({
    content: [{ type: "text", text: `echo:${params?.arguments?.text ?? ""}` }],
  }),
};
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    const handler = methods[message.method];
    if (message.id === undefined) continue;
    const response = handler
      ? { jsonrpc: "2.0", id: message.id, result: handler(message.params) }
      : {
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32601, message: "Method not found" },
        };
    process.stdout.write(JSON.stringify(response) + "\n");
  }
});
