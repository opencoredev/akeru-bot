import * as Context from "effect/Context";

import type { ProviderServiceShape } from "./ProviderService.ts";

/**
 * Adapter from Akeru's AgentController seam to the existing subscription-backed
 * provider runtimes. Mastra cannot drive the provider CLI session contract, so
 * the bridge keeps those adapters behind the controller instead of exposing
 * them to orchestration reactors.
 */
export class LegacyProviderBridge extends Context.Service<
  LegacyProviderBridge,
  ProviderServiceShape
>()("akeru-bot/provider/Services/LegacyProviderBridge") {}
