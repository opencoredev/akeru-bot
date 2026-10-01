import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Match from "effect/Match";
import * as Predicate from "effect/Predicate";
// @effect-diagnostics globalFetch:off nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { Workspace } from "@mastra/core/workspace";
import {
  type RemoteBotSandbox,
  type AkeruBotWorkspace,
  REMOTE_BOT_SANDBOXES,
} from "./BotWorkspaceTypes.ts";

export function wrap(
  workspace: Workspace,
  provider: "local" | RemoteBotSandbox,
): AkeruBotWorkspace {
  return {
    id: workspace.id,
    provider,
    workspace,
    inspect: async () =>
      Match.value(workspace.status).pipe(
        Match.when("destroyed", () => "missing" as const),
        Match.when("paused", () => "sleeping" as const),
        Match.orElse(() => "running" as const),
      ),
    wake: () => workspace.init(),
    sleep: () => workspace.stop(),
    destroy: () => workspace.destroy(),
  };
}

const decodeIdentity = Schema.decodeUnknownOption(
  Schema.Struct({ provider: Schema.Literals(REMOTE_BOT_SANDBOXES), providerId: Schema.String }),
);

export async function readIdentity(path: string) {
  try {
    const value = Option.getOrUndefined(
      decodeIdentity(JSON.parse(await NodeFS.promises.readFile(path, "utf8"))),
    );

    if (!value || !value.providerId)
      throw new Error(`Workspace identity file '${path}' is invalid.`);

    return value;
  } catch (cause) {
    if (Predicate.isObject(cause) && "code" in cause && cause.code === "ENOENT") return undefined;
    throw cause;
  }
}

export async function writeIdentity(
  path: string,
  identity: { provider: RemoteBotSandbox; providerId: string },
) {
  await NodeFS.promises.mkdir(NodePath.dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await NodeFS.promises.writeFile(temporary, `${JSON.stringify(identity)}\n`, { mode: 0o600 });
  await NodeFS.promises.rename(temporary, path);
}

export const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

export const commandLine = (command: string, args: readonly string[]) =>
  [command, ...args].map(quote).join(" ");

export function credential(environment: Readonly<Record<string, string>>, name: string): string {
  const value = environment[name]?.trim();

  if (!value) throw new Error(`Remote sandbox credential '${name}' is missing.`);

  return value;
}
