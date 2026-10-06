import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

export const CLOUD_STAGES = ["production", "staging", "local"] as const;

export type CloudStage = (typeof CLOUD_STAGES)[number];

export const isCloudStage = (value: string | undefined): value is CloudStage =>
  CLOUD_STAGES.some((stage) => stage === value);

/** Secrets for one stage, shared by every checkout on this machine. */
export const machineEnvPath = (stage: CloudStage, home: string) =>
  NodePath.join(home, ".config", "akeru-cloud", `${stage}.env`);

/**
 * Builds the environment Alchemy runs with. Later sources win: the process
 * environment, then `~/.config/akeru-cloud/<stage>.env`, then the checkout's
 * optional `apps/cloud/.env`. Returns the files it read, never their values.
 */
export function loadStageEnv(input: {
  readonly stage: CloudStage;
  readonly home: string;
  readonly packageDir: string;
  readonly env: NodeJS.ProcessEnv;
}) {
  const env: NodeJS.ProcessEnv = { ...input.env };
  const loaded: string[] = [];

  for (const file of [
    machineEnvPath(input.stage, input.home),
    NodePath.join(input.packageDir, ".env"),
  ]) {
    if (!NodeFS.existsSync(file)) continue;
    Object.assign(env, NodeUtil.parseEnv(NodeFS.readFileSync(file, "utf8")));
    loaded.push(file);
  }

  return { env, loaded };
}
