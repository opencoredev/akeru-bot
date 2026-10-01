// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

export const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));

export const mockAgentPath = NodePath.join(__dirname, "../../../../scripts/acp-mock-agent.ts");

export const mockAgentCommand = "node";

export const mockAgentArgs = [mockAgentPath];
