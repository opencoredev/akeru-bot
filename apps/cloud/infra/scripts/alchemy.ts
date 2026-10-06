/**
 * Runs the Alchemy CLI with the stage's secrets loaded, so any checkout on this
 * machine can deploy or run the cloud. Usage: `node scripts/alchemy.ts <command> --stage <stage> [...]`.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeOS from "node:os";
import * as NodeURL from "node:url";

import { CLOUD_STAGES, isCloudStage, loadStageEnv } from "./stageEnv.ts";

const args = process.argv.slice(2);

const stage = args[args.indexOf("--stage") + 1];

if (!args.includes("--stage") || !isCloudStage(stage)) {
  console.error(`[cloud] pass --stage ${CLOUD_STAGES.join("|")}`);
  process.exit(2);
}

const infraDir = NodeURL.fileURLToPath(new URL("..", import.meta.url));

// The checkout's optional .env stays in apps/cloud, next to .env.example.
const cloudDir = NodeURL.fileURLToPath(new URL("../..", import.meta.url));

const { env, loaded } = loadStageEnv({
  stage,
  home: NodeOS.homedir(),
  packageDir: cloudDir,
  env: process.env,
});

console.error(
  `[cloud] ${stage}: configuration from ${loaded.length > 0 ? loaded.join(", ") : "the shell only"}`,
);

const alchemy = NodeURL.fileURLToPath(new URL("../node_modules/.bin/alchemy", import.meta.url));

const child = NodeChildProcess.spawn(alchemy, args, { cwd: infraDir, env, stdio: "inherit" });

child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
