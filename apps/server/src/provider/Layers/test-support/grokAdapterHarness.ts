// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeFSP from "node:fs/promises";
import * as NodeURL from "node:url";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { GrokSettings } from "@akeru/contracts";
import { ServerConfig } from "../../../config.ts";
import { makeGrokAdapter } from "../GrokAdapter.ts";

export const decodeGrokSettings = Schema.decodeSync(GrokSettings);

export const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));

export const mockAgentPath = NodePath.join(__dirname, "../../../../scripts/acp-mock-agent.ts");

export const mockAgentCommand = process.execPath;

export async function makeMockGrokWrapper(extraEnv?: Record<string, string>) {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "grok-acp-mock-"));
  const wrapperPath = NodePath.join(dir, "fake-grok.sh");

  const envExports = Object.entries(extraEnv ?? {})
    .map(([key, value]) => `export ${key}=${JSON.stringify(value)}`)
    .join("\n");

  const script = `#!/bin/sh
${envExports}
exec ${JSON.stringify(mockAgentCommand)} ${JSON.stringify(mockAgentPath)} "$@"
`;

  await NodeFSP.writeFile(wrapperPath, script, "utf8");
  await NodeFSP.chmod(wrapperPath, 0o755);

  return wrapperPath;
}

export function waitForFileContent(
  filePath: string,
  attempts = 40,
  expectedContent?: string,
): Effect.Effect<string> {
  const readAttempt = (remainingAttempts: number): Effect.Effect<string> =>
    Effect.gen(function* () {
      if (remainingAttempts <= 0) {
        return yield* Effect.die(new Error(`Timed out waiting for file content at ${filePath}`));
      }

      const raw = yield* Effect.tryPromise(() => NodeFSP.readFile(filePath, "utf8")).pipe(
        Effect.orElseSucceed(() => ""),
      );

      if (
        raw.trim().length > 0 &&
        (expectedContent === undefined || raw.includes(expectedContent))
      ) {
        return raw;
      }

      yield* Effect.sleep("25 millis");

      return yield* readAttempt(remainingAttempts - 1);
    });

  return readAttempt(attempts);
}

export async function readJsonLines(filePath: string) {
  const raw = await NodeFSP.readFile(filePath, "utf8");

  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

export const grokAdapterTestLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-grok-adapter-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

export const makeTestAdapter = (
  binaryPath: string,
  options?: Parameters<typeof makeGrokAdapter>[1],
) => makeGrokAdapter(decodeGrokSettings({ binaryPath }), options).pipe(Effect.orDie);
