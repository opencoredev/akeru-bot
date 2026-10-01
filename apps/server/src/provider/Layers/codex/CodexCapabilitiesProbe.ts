import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Types from "effect/Types";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as CodexClient from "effect-codex-app-server/client";
import * as CodexSchema from "effect-codex-app-server/schema";
import * as CodexErrors from "effect-codex-app-server/errors";
import type { ServerProviderModel, ServerProviderSkill } from "@akeru/contracts";
import { resolveSpawnCommand } from "@akeru/shared/shell";
import { codexAppServerArgs } from "../codexLaunchArgs.ts";
import { expandHomePath } from "../../../pathExpansion.ts";
import packageJson from "../../../../package.json" with { type: "json" };

import { type CodexAppServerProviderSnapshot } from "./CodexProviderState.ts";
import {
  parseCodexModelListResponse,
  applyPreferredCodexDefaultModel,
  appendCustomCodexModels,
} from "./CodexModels.ts";

export const isCodexAppServerSpawnError = Schema.is(CodexErrors.CodexAppServerSpawnError);

export const CODEX_APP_SERVER_PROBE_FORCE_KILL_AFTER = "2 seconds" as const;

/**
 * Canonicalize a cwd for comparison against `skills/list` entries. The
 * app-server records real paths, so a symlinked or otherwise unnormalized
 * requested cwd would never match without this. When realpath fails (the
 * directory does not exist yet) the raw path is used so the entry can still
 * match an equally raw reported cwd. Runs on the Effect FileSystem so a
 * slow or unreachable filesystem never blocks the server event loop.
 */
export const realPathOrSelf = (
  fileSystem: FileSystem.FileSystem,
  cwd: string,
): Effect.Effect<string> => fileSystem.realPath(cwd).pipe(Effect.orElseSucceed(() => cwd));

export const parseCodexSkillsListResponse = Effect.fn("parseCodexSkillsListResponse")(function* (
  response: CodexSchema.V2SkillsListResponse,
  cwd: string,
): Effect.fn.Return<ReadonlyArray<ServerProviderSkill>, never, FileSystem.FileSystem> {
  const fileSystem = yield* FileSystem.FileSystem;
  const canonicalCwd = yield* realPathOrSelf(fileSystem, cwd);
  // Resolve each distinct reported root once; a workspace appearing in
  // multiple entries only pays for a single realpath.
  const distinctRoots = [...new Set(response.data.map((entry) => entry.cwd))];

  const canonicalRoots = new Map(
    yield* Effect.forEach(
      distinctRoots,
      (root) => Effect.map(realPathOrSelf(fileSystem, root), (real) => [root, real] as const),
      { concurrency: "unbounded" },
    ),
  );

  const matchingEntry = response.data.find(
    (entry) => canonicalRoots.get(entry.cwd) === canonicalCwd,
  );

  // No matching entry means the provider reported nothing for this
  // workspace. Never union the other workspaces' catalogs: skills from
  // unrelated directories are not skills this provider would load here.
  const skills = matchingEntry ? matchingEntry.skills : [];

  return skills.map((skill) => {
    const shortDescription =
      skill.shortDescription ?? skill.interface?.shortDescription ?? undefined;

    const parsedSkill: Types.Mutable<ServerProviderSkill> = {
      name: skill.name,
      path: skill.path,
      enabled: skill.enabled,
    };

    if (skill.description) {
      parsedSkill.description = skill.description;
    }

    if (skill.scope) {
      parsedSkill.scope = skill.scope;
    }

    if (skill.interface?.displayName) {
      parsedSkill.displayName = skill.interface.displayName;
    }

    if (shortDescription) {
      parsedSkill.shortDescription = shortDescription;
    }

    // Prefer the small icon asset path; fall back to the large one when the
    // provider only ships a single size.
    const icon = skill.interface?.iconSmall ?? skill.interface?.iconLarge ?? undefined;

    if (icon) {
      parsedSkill.icon = icon;
    }

    return parsedSkill;
  });
});

export const requestAllCodexModels = Effect.fn("requestAllCodexModels")(function* (
  client: CodexClient.CodexAppServerClient["Service"],
) {
  const models: ServerProviderModel[] = [];
  let cursor: string | null | undefined = undefined;

  do {
    const response: CodexSchema.V2ModelListResponse = yield* client.request(
      "model/list",
      cursor ? { cursor } : {},
    );

    models.push(...parseCodexModelListResponse(response));
    cursor = response.nextCursor;
  } while (cursor);

  return models;
});

export function buildCodexInitializeParams(): CodexSchema.V1InitializeParams {
  return {
    clientInfo: {
      name: "akeru_bot_desktop",
      title: "Akeru Bot Desktop",
      version: packageJson.version,
    },
    capabilities: {
      experimentalApi: true,
    },
  };
}

export const probeCodexAppServerProvider = Effect.fn("probeCodexAppServerProvider")(
  function* (input: {
    readonly binaryPath: string;
    readonly homePath?: string;
    readonly launchArgs?: string;
    readonly cwd: string;
    readonly customModels?: ReadonlyArray<string>;
    readonly environment?: NodeJS.ProcessEnv;
  }) {
    // `~` is not shell-expanded when env vars are set via `child_process.spawn`,
    // so `CODEX_HOME=~/.codex_work` would reach codex verbatim and trip
    // "CODEX_HOME points to '~/.codex_work', but that path does not exist".
    // Expand here for parity with `CodexTextGeneration`/`CodexSessionRuntime`.
    const resolvedHomePath = input.homePath ? expandHomePath(input.homePath) : undefined;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    const environment = {
      ...input.environment,
      ...(resolvedHomePath ? { CODEX_HOME: resolvedHomePath } : {}),
    };

    const spawnCommand = yield* resolveSpawnCommand(
      input.binaryPath,
      codexAppServerArgs(input.launchArgs),
      {
        env: environment,
        extendEnv: true,
      },
    );

    const child = yield* spawner
      .spawn(
        ChildProcess.make(spawnCommand.command, spawnCommand.args, {
          cwd: input.cwd,
          env: environment,
          extendEnv: true,
          forceKillAfter: CODEX_APP_SERVER_PROBE_FORCE_KILL_AFTER,
          shell: spawnCommand.shell,
        }),
      )
      .pipe(
        Effect.mapError(
          (cause) =>
            new CodexErrors.CodexAppServerSpawnError({
              command: `${input.binaryPath} app-server`,
              cause,
            }),
        ),
      );

    const clientContext = yield* Layer.build(CodexClient.layerChildProcess(child));

    const client = yield* Effect.service(CodexClient.CodexAppServerClient).pipe(
      Effect.provide(clientContext),
    );

    const initialize = yield* client.request("initialize", {
      clientInfo: {
        name: "akeru_bot_desktop",
        title: "Akeru Bot Desktop",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: true,
      },
    });

    yield* client.notify("initialized", undefined);

    // Extract the version string after the first '/' in userAgent, up to the next space or the end
    const versionMatch = initialize.userAgent.match(/\/([^\s]+)/);
    const version = versionMatch ? versionMatch[1] : undefined;

    const accountResponse = yield* client.request("account/read", {});

    if (!accountResponse.account && accountResponse.requiresOpenaiAuth) {
      return {
        account: accountResponse,
        version,
        models: appendCustomCodexModels([], input.customModels ?? []),
        skills: [],
      } satisfies CodexAppServerProviderSnapshot;
    }

    const [skillsResponse, models] = yield* Effect.all(
      [
        client.request("skills/list", {
          cwds: [input.cwd],
        }),
        requestAllCodexModels(client),
      ],
      { concurrency: "unbounded" },
    );

    return {
      account: accountResponse,
      version,
      models: applyPreferredCodexDefaultModel(
        appendCustomCodexModels(models, input.customModels ?? []),
      ),
      skills: yield* parseCodexSkillsListResponse(skillsResponse, input.cwd),
    } satisfies CodexAppServerProviderSnapshot;
  },
);
