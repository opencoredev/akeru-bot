import * as Duration from "effect/Duration";
import * as Schema from "effect/Schema";

export const WELL_KNOWN_ENVIRONMENT_PATH = "/.well-known/t3/environment";

export const PAIR_PROBE_TIMEOUT = Duration.millis(2_500);

export // Tailscale provisions an HTTPS certificate on the first request to a fresh
// serve mapping, which can take a few seconds.
const TAILSCALE_PROBE_ATTEMPTS = 5;

export const TAILSCALE_PROBE_RETRY_DELAY = Duration.seconds(1);

export type PairStateVariant = "userdata" | "dev";

export // deriveServerPaths only checks devUrl for undefined-ness when picking the
// dev-vs-userdata state directory; the value itself is not used.
const DEV_VARIANT_PLACEHOLDER_URL = new URL("http://localhost");

export class NoRunningServerError extends Schema.TaggedErrorClass<NoRunningServerError>()(
  "NoRunningServerError",
  {
    checkedStatePaths: Schema.Array(Schema.String),
  },
) {
  override get message(): string {
    return [
      "No running Akeru Bot server found.",
      ...this.checkedStatePaths.map((statePath) => `  checked ${statePath}`),
      "Start one with `npx akeru-bot serve`.",
    ].join("\n");
  }
}

// Each tailscale failure gets its own class (same reasoning as
// scripts/lib/dev-share.ts): distinct caller-visible message, distinct remedy.
export class TailscaleUnavailableError extends Schema.TaggedErrorClass<TailscaleUnavailableError>()(
  "TailscaleUnavailableError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not talk to Tailscale. Is tailscaled running? Try `tailscale status`.";
  }
}

export class MagicDnsNameMissingError extends Schema.TaggedErrorClass<MagicDnsNameMissingError>()(
  "MagicDnsNameMissingError",
  {},
) {
  override get message(): string {
    return "This machine has no MagicDNS name. Run `tailscale up` and enable MagicDNS.";
  }
}

export class ServesOtherEnvironmentError extends Schema.TaggedErrorClass<ServesOtherEnvironmentError>()(
  "ServesOtherEnvironmentError",
  { servePort: Schema.Number },
) {
  override get message(): string {
    return `Tailscale Serve on HTTPS port ${String(this.servePort)} already fronts a different Akeru Bot server. Pass --tailscale-serve-port to publish this one on another port.`;
  }
}

export class TailscaleServeFailedError extends Schema.TaggedErrorClass<TailscaleServeFailedError>()(
  "TailscaleServeFailedError",
  { servePort: Schema.Number, cause: Schema.Defect() },
) {
  override get message(): string {
    return `tailscale serve failed for HTTPS port ${String(this.servePort)}. Run \`tailscale serve --https=${String(this.servePort)} --bg <local-url>\` by hand to see why.`;
  }
}

export class ServePortOccupiedError extends Schema.TaggedErrorClass<ServePortOccupiedError>()(
  "ServePortOccupiedError",
  { servePort: Schema.Number },
) {
  override get message(): string {
    return `HTTPS port ${String(this.servePort)} on the tailnet already serves something that is not an Akeru Bot server. Pass --tailscale-serve-port to publish this one on another port.`;
  }
}

export class AdminAlreadyPairedError extends Schema.TaggedErrorClass<AdminAlreadyPairedError>()(
  "AdminAlreadyPairedError",
  {},
) {
  override get message(): string {
    return "An admin client is already paired, so `akeru pair --admin` is closed. Pair new devices from Settings > Connections on that client, or run `akeru pair` for a standard link.";
  }
}

export class InvalidPublicUrlError extends Schema.TaggedErrorClass<InvalidPublicUrlError>()(
  "InvalidPublicUrlError",
  { publicUrl: Schema.String, reason: Schema.String },
) {
  override get message(): string {
    return `--public-url ${this.publicUrl} ${this.reason}. Pass the origin your tunnel serves, for example https://akeru.example.com.`;
  }
}

export class PublicUrlWithTailscaleError extends Schema.TaggedErrorClass<PublicUrlWithTailscaleError>()(
  "PublicUrlWithTailscaleError",
  {},
) {
  override get message(): string {
    return "Pass either --public-url or --tailscale, not both.";
  }
}

export /**
 * Errors whose message already tells the user what to do, printed without a
 * stack trace. Anything else in the channel — auth-store failures, config
 * errors, defects — falls through to `runMain` with its cause intact.
 */
const PAIR_USER_FACING_ERROR_TAGS = [
  "NoRunningServerError",
  "InvalidPublicUrlError",
  "PublicUrlWithTailscaleError",
  "AdminAlreadyPairedError",
  "MagicDnsNameMissingError",
  "ServesOtherEnvironmentError",
  "ServePortOccupiedError",
  "TailscaleServeFailedError",
  "DevServerNotProxiableError",
  "TailscaleUnavailableError",
] as const;

export class DevServerNotProxiableError extends Schema.TaggedErrorClass<DevServerNotProxiableError>()(
  "DevServerNotProxiableError",
  { devUrl: Schema.String },
) {
  override get message(): string {
    return `Tailscale Serve can only proxy plain-HTTP local targets, and this dev server runs at ${this.devUrl}. Pair without --tailscale instead.`;
  }
}

export const isDevServerNotProxiableError = Schema.is(DevServerNotProxiableError);
