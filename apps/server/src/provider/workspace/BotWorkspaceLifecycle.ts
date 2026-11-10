import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Match from "effect/Match";
import type { BotWorkspaceIO } from "./BotWorkspaceIO.ts";
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

/**
 * The saved sandbox identity. `workdir` marks identities written since the sandbox-sdk
 * migration; an identity without it belongs to a sandbox an old adapter created, whose
 * files live in that provider's own default directory.
 */
const WorkspaceIdentity = Schema.Struct({
  provider: Schema.Literals(REMOTE_BOT_SANDBOXES),
  providerId: Schema.String,
  workdir: Schema.optionalKey(Schema.String),
  /** The user a legacy sandbox's commands and new files belong to, where the SDK runs as another. */
  user: Schema.optionalKey(Schema.String),
  /** Set for a sandbox whose setup failed: the next open deletes it instead of reattaching. */
  cleanup: Schema.optionalKey(Schema.Literal(true)),
});

export type WorkspaceIdentity = typeof WorkspaceIdentity.Type;

const decodeIdentity = Schema.decodeUnknownOption(WorkspaceIdentity);

export async function readIdentity(io: BotWorkspaceIO, path: string) {
  const content = await io.readIdentity(path);

  if (content === undefined) return undefined;
  const value = Option.getOrUndefined(decodeIdentity(JSON.parse(content)));

  if (!value || !value.providerId) throw new Error(`Workspace identity file '${path}' is invalid.`);

  return value;
}

export async function writeIdentity(io: BotWorkspaceIO, path: string, identity: WorkspaceIdentity) {
  await io.mkdir(io.path.dirname(path));
  const temporary = `${path}.${process.pid}.tmp`;
  await io.writeIdentity(temporary, `${JSON.stringify(identity)}\n`);
  await io.rename(temporary, path);
}

export const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

export const commandLine = (command: string, args: readonly string[]) =>
  [command, ...args].map(quote).join(" ");

export function credential(environment: Readonly<Record<string, string>>, name: string): string {
  const value = environment[name]?.trim();

  if (!value) throw new Error(`Remote sandbox credential '${name}' is missing.`);

  return value;
}
