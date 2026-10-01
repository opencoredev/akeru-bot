import { PortSchema } from "@akeru/contracts";
import { DEFAULT_TAILSCALE_SERVE_PORT } from "@akeru/tailscale";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Command, Flag, GlobalFlag } from "effect/unstable/cli";
import { FetchHttpClient } from "effect/unstable/http";
import { reportExpectedCliError } from "./errors.ts";
import { buildPairingUrl, isLoopbackHost } from "../startupAccess.ts";
import { baseDirFlag, DurationFromString } from "./config.ts";
import { PAIR_USER_FACING_ERROR_TAGS } from "./pairTypes.ts";
import {
  resolvePublicPairingBaseUrl,
  resolveDirectPairingBaseUrl,
  discoverPairTarget,
  resolveTailscalePairingBase,
} from "./pairTarget.ts";
import { PairStdoutIsTerminal, formatPairOutput } from "./pairOutput.ts";
import { makePairServerConfig, mintPairingLink } from "./pairIssuer.ts";
const ttlFlag = Flag.string("ttl").pipe(
  Flag.withSchema(DurationFromString),
  Flag.withDescription(
    "Token TTL, for example `5m`, `1h`, or `15 minutes`. Defaults to 5 minutes.",
  ),
  Flag.optional,
);

const labelFlag = Flag.string("label").pipe(
  Flag.withDescription("Optional label shown in the server's connections list."),
  Flag.optional,
);

const tailscaleFlag = Flag.boolean("tailscale").pipe(
  Flag.withDescription(
    "Publish the server over Tailscale Serve HTTPS and pair through the tailnet URL.",
  ),
  Flag.withDefault(false),
);

const tailscaleServePortFlag = Flag.integer("tailscale-serve-port").pipe(
  Flag.withSchema(PortSchema),
  Flag.withDescription("HTTPS port for Tailscale Serve when --tailscale is enabled."),
  Flag.withDefault(DEFAULT_TAILSCALE_SERVE_PORT),
);

const publicUrlFlag = Flag.string("public-url").pipe(
  Flag.withDescription(
    "Build the pairing URL on this http(s) origin, for example the address of a tunnel or reverse proxy in front of the server.",
  ),
  Flag.optional,
);

const adminFlag = Flag.boolean("admin").pipe(
  Flag.withDescription(
    "Mint an admin link that can pair and revoke other clients and change Connections. Works only on this machine and only until an admin client is paired.",
  ),
  Flag.withDefault(false),
);

const qrFlag = Flag.boolean("qr").pipe(
  Flag.withDescription(
    "Print a QR code of the pairing URL. On by default when stdout is a terminal; turn it off with --no-qr.",
  ),
  Flag.withDefault(true),
);

export const pairCommand = Command.make("pair", {
  baseDir: baseDirFlag,
  ttl: ttlFlag,
  label: labelFlag,
  tailscale: tailscaleFlag,
  tailscaleServePort: tailscaleServePortFlag,
  publicUrl: publicUrlFlag,
  admin: adminFlag,
  qr: qrFlag,
}).pipe(
  Command.withDescription(
    "Mint a pairing token for a running Akeru Bot server and print it as a QR code.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const cliLogLevel = yield* GlobalFlag.LogLevel;
      // Default to Warn so storage/migration chatter cannot bury the QR code;
      // an explicit --log-level still wins.
      const logLevel = Option.getOrElse(cliLogLevel, () => "Warn" as const);

      const publicUrl = yield* resolvePublicPairingBaseUrl({
        publicUrl: flags.publicUrl,
        tailscale: flags.tailscale,
      });

      const target = yield* discoverPairTarget(Option.getOrUndefined(flags.baseDir));

      const notes: Array<string> = [];
      let pairingBaseUrl: string;
      if (publicUrl !== undefined) {
        // The tunnel is the user's; the server cannot probe it from here without assuming it
        // loops back, so the URL is used as given.
        pairingBaseUrl = publicUrl;
      } else if (flags.tailscale) {
        const resolved = yield* resolveTailscalePairingBase({
          target,
          servePort: flags.tailscaleServePort,
        });
        pairingBaseUrl = resolved.baseUrl;
        notes.push(...resolved.notes);
      } else {
        pairingBaseUrl = resolveDirectPairingBaseUrl(target.state);
        if (isLoopbackHost(new URL(pairingBaseUrl).hostname)) {
          notes.push(
            "This URL is only reachable from this machine. Re-run with --tailscale, or restart the server with a reachable --host.",
          );
        }
        if (target.variant === "dev" && target.state.devUrl === undefined) {
          notes.push(
            "This dev server did not record its web URL; restart it so pairing can go through the web origin.",
          );
        }
      }

      const config = yield* makePairServerConfig({ target, logLevel });
      const issued = yield* mintPairingLink({
        config,
        ttl: flags.ttl,
        label: flags.label,
        admin: flags.admin,
      });
      if (flags.admin) {
        notes.unshift(
          "This link grants admin scope: that device can pair and revoke other clients and change Connections. It works once.",
        );
      }
      const pairingUrl = buildPairingUrl(pairingBaseUrl, issued.credential);

      yield* Console.log(
        formatPairOutput({
          serverLabel: target.descriptor.label,
          origin: target.state.origin,
          pairingUrl,
          token: issued.credential,
          expiresAt: issued.expiresAt,
          notes,
          qrCode: flags.qr && (yield* PairStdoutIsTerminal),
        }),
      );
    }).pipe(
      reportExpectedCliError(PAIR_USER_FACING_ERROR_TAGS),
      Effect.provide(FetchHttpClient.layer),
    ),
  ),
);
export type { PairStateVariant } from "./pairTypes.ts";
export { NoRunningServerError } from "./pairTypes.ts";
export { TailscaleUnavailableError } from "./pairTypes.ts";
export { MagicDnsNameMissingError } from "./pairTypes.ts";
export { ServesOtherEnvironmentError } from "./pairTypes.ts";
export { TailscaleServeFailedError } from "./pairTypes.ts";
export { ServePortOccupiedError } from "./pairTypes.ts";
export { AdminAlreadyPairedError } from "./pairTypes.ts";
export { InvalidPublicUrlError } from "./pairTypes.ts";
export { PublicUrlWithTailscaleError } from "./pairTypes.ts";
export { parsePublicPairingBaseUrl } from "./pairTarget.ts";
export { resolveDirectPairingBaseUrl } from "./pairTarget.ts";
export { DevServerNotProxiableError } from "./pairTypes.ts";
export { resolveTailscaleLocalTarget } from "./pairTarget.ts";
export { PairStdoutIsTerminal } from "./pairOutput.ts";
export { formatPairOutput } from "./pairOutput.ts";
export { issueAdminPairingLink } from "./pairIssuer.ts";
