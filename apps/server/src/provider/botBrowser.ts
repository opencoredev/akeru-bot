// @effect-diagnostics globalFetch:off nodeBuiltinImport:off
import { type CreateBotBrowserInput, type BotBrowser } from "./browser/BotBrowserTypes.ts";
import { LightpandaRpc, createBotBrowserTools } from "./browser/LightpandaRpc.ts";

export function createBotBrowser(input: CreateBotBrowserInput): BotBrowser {
  const rpc = input.makeRpc?.(input) ?? new LightpandaRpc(input);
  return {
    tools: createBotBrowserTools(rpc),
    attachment: () => rpc.attachment(),
    reconnect: () => rpc.reconnect(),
    close: () => rpc.close(),
  };
}

export {
  type BotBrowserAttachment,
  type BotBrowser,
  type BotBrowserRpc,
  type BotBrowserProcessInput,
  type CreateBotBrowserInput,
  type BrowserHttpResponse,
  type BrowserRequest,
} from "./browser/BotBrowserTypes.ts";

export { lightpandaMcpCommand } from "./browser/LightpandaInstall.ts";

export { browserMonitorRetryDelayMs } from "./browser/LightpandaProcess.ts";

export { browserRpcErrorMessage, createBotBrowserTools } from "./browser/LightpandaRpc.ts";
