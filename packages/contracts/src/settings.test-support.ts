import * as Schema from "effect/Schema";
import {
  ClientSettingsSchema,
  ClientSettingsPatch,
  ClaudeSettings,
  ServerSettings,
  ServerSettingsPatch,
  ServerSettingsRpcPatch,
} from "./settings.ts";

export const decodeClientSettings = Schema.decodeUnknownSync(ClientSettingsSchema);

export const decodeClientSettingsPatch = Schema.decodeUnknownSync(ClientSettingsPatch);

export const decodeServerSettings = Schema.decodeUnknownSync(ServerSettings);

export const decodeServerSettingsPatch = Schema.decodeUnknownSync(ServerSettingsPatch);

export const decodeServerSettingsRpcPatch = Schema.decodeUnknownSync(ServerSettingsRpcPatch);

export const encodeServerSettings = Schema.encodeSync(ServerSettings);

export const decodeClaudeSettings = Schema.decodeUnknownSync(ClaudeSettings);
