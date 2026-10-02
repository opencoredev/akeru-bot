import * as CodexSchema from "effect-codex-app-server/schema";
import type { ServerProviderModel, ServerProviderSkill } from "@akeru/contracts";

export const CODEX_PRESENTATION = {
  displayName: "Codex",
  showInteractionModeToggle: true,
} as const;

export interface CodexAppServerProviderSnapshot {
  readonly account: CodexSchema.V2GetAccountResponse;
  readonly version: string | undefined;
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly skills: ReadonlyArray<ServerProviderSkill>;
}
