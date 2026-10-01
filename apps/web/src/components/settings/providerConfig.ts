import { Option, Schema } from "effect";
import type { ProviderInstanceConfig } from "@akeru/contracts";

export type ProviderConfig = Schema.JsonObject;

const decodeConfig = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Json));

/** Provider blobs cross RPC as opaque data; settings only edit JSON object fields. */
export function providerConfig(config: ProviderInstanceConfig["config"]): ProviderConfig {
  return Option.getOrElse(decodeConfig(config), () => ({}));
}

export type MutableProviderConfig = { -readonly [K in keyof ProviderConfig]: ProviderConfig[K] };
