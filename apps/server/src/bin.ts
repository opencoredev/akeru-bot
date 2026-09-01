import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Command } from "effect/unstable/cli";

import * as NetService from "@t3tools/shared/Net";
import packageJson from "../package.json" with { type: "json" };
import { authCommand } from "./cli/auth.ts";
import { pairCommand } from "./cli/pair.ts";
import { sharedServerCommandFlags } from "./cli/config.ts";
import { isEntrypoint } from "./entrypoint.ts";
import { projectCommand } from "./cli/project.ts";
import { runServerCommand, serveCommand, startCommand } from "./cli/server.ts";
import { serviceCommand } from "./cli/service.ts";
import { servicePreflightCommand } from "./cli/servicePreflight.ts";
import { triageCommand } from "./cli/triage.ts";

const CliRuntimeLayer = Layer.mergeAll(NodeServices.layer, NetService.layer);

export const makeCli = () =>
  Command.make("akeru", { ...sharedServerCommandFlags }).pipe(
    Command.withDescription("Run the Akeru Bot server."),
    Command.withHandler((flags) => runServerCommand(flags)),
    Command.withSubcommands([
      startCommand,
      serveCommand,
      pairCommand,
      authCommand,
      projectCommand,
      serviceCommand,
      servicePreflightCommand,
      triageCommand,
    ]),
  );

export const cli = makeCli();

if (
  isEntrypoint({
    moduleUrl: import.meta.url,
    entryPath: process.argv[1],
    runtimeMain: import.meta.main,
  })
) {
  Command.run(cli, { version: packageJson.version }).pipe(
    Effect.scoped,
    Effect.provide(CliRuntimeLayer),
    NodeRuntime.runMain,
  );
}
