import { AkeruToolInputSchemas, decodeAkeruToolInput } from "@akeru/contracts";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { AkeruMemoryToolInputSchema } from "../../memory/BotMemoryToolHandlers.ts";
import type { AkeruRuntimeToolId } from "./AkeruToolTypes.ts";

const decodeMemoryInput = Schema.decodeUnknownSync(AkeruMemoryToolInputSchema);

export function normalizeAkeruToolInput<Input>(
  toolId: Exclude<AkeruRuntimeToolId, "memory">,
  input: Input,
  omitUnknownNulls = false,
) {
  if (!Predicate.isObject(input) || Array.isArray(input)) return input;

  const schema = AkeruToolInputSchemas[toolId];
  const fields: Readonly<Record<string, Schema.Top>> = "fields" in schema ? schema.fields : {};

  return Object.fromEntries(
    Object.entries(input).filter(([key, value]) => {
      const field = fields[key];

      return (
        value !== null ||
        (field ? !Schema.is(field)(undefined) || Schema.is(field)(null) : !omitUnknownNulls)
      );
    }),
  );
}

export function decodeAkeruRuntimeToolInput<Input>(
  toolId: AkeruRuntimeToolId,
  input: Input,
  options?: { readonly approvalGrant: boolean },
) {
  if (toolId === "memory")
    return { toolId, input: decodeMemoryInput(input, { onExcessProperty: "error" }) };
  const normalized = normalizeAkeruToolInput(toolId, input, options?.approvalGrant);

  switch (toolId) {
    case "Shell":
      return { toolId, input: decodeAkeruToolInput(toolId, normalized) };
    case "Read":
      return { toolId, input: decodeAkeruToolInput(toolId, normalized) };
    case "Screenshot":
      return { toolId, input: decodeAkeruToolInput(toolId, normalized) };
    case "CopyToBox":
      return { toolId, input: decodeAkeruToolInput(toolId, normalized) };
    case "CopyFromBox":
      return { toolId, input: decodeAkeruToolInput(toolId, normalized) };
    case "request_box_help":
      return { toolId, input: decodeAkeruToolInput(toolId, normalized) };
    case "ExternalShell":
      return { toolId, input: decodeAkeruToolInput(toolId, normalized) };
    case "ExternalRead":
      return { toolId, input: decodeAkeruToolInput(toolId, normalized) };
    case "AwaitShell":
      return { toolId, input: decodeAkeruToolInput(toolId, normalized) };
    case "AwaitExternalShell":
      return { toolId, input: decodeAkeruToolInput(toolId, normalized) };
    case "CreateAgent":
      return { toolId, input: decodeAkeruToolInput(toolId, normalized) };
    case "CheckAgent":
      return { toolId, input: decodeAkeruToolInput(toolId, normalized) };
    case "MessageAgent":
      return { toolId, input: decodeAkeruToolInput(toolId, normalized) };
    case "StopAgent":
      return { toolId, input: decodeAkeruToolInput(toolId, normalized) };
    case "SendToAgent":
      return { toolId, input: decodeAkeruToolInput(toolId, normalized) };
    case "CreateChannel":
      return { toolId, input: decodeAkeruToolInput(toolId, normalized) };
    case "UpdateChannel":
      return { toolId, input: decodeAkeruToolInput(toolId, normalized) };
    case "SendToUser":
      return { toolId, input: decodeAkeruToolInput(toolId, normalized) };
    case "SearchPlugins":
      return { toolId, input: decodeAkeruToolInput(toolId, normalized) };
    case "GetPlugin":
      return { toolId, input: decodeAkeruToolInput(toolId, normalized) };
    case "ReactToMessage":
      return { toolId, input: decodeAkeruToolInput(toolId, normalized) };
    case "InstallPlugin":
      return { toolId, input: decodeAkeruToolInput(toolId, normalized) };
    case "UninstallPlugin":
      return { toolId, input: decodeAkeruToolInput(toolId, normalized) };
    case "GetMcpServerStatus":
      return { toolId, input: decodeAkeruToolInput(toolId, normalized) };
    case "TestMcpServer":
      return { toolId, input: decodeAkeruToolInput(toolId, normalized) };
    case "ReconnectMcpServer":
      return { toolId, input: decodeAkeruToolInput(toolId, normalized) };
    case "UpdateBotProfile":
      return { toolId, input: decodeAkeruToolInput(toolId, normalized) };
    case "AuthenticateMcpServer":
      return { toolId, input: decodeAkeruToolInput(toolId, normalized) };
    case "RestartMcpServers":
      return { toolId, input: decodeAkeruToolInput(toolId, normalized) };
    case "WebSearch":
      return { toolId, input: decodeAkeruToolInput(toolId, normalized) };
    case "WebFetch":
      return { toolId, input: decodeAkeruToolInput(toolId, normalized) };
    case "GenerateImage":
      return { toolId, input: decodeAkeruToolInput(toolId, normalized) };
    case "AddMcpServer":
      return { toolId, input: decodeAkeruToolInput(toolId, normalized) };
    case "UninstallMcpServer":
      return { toolId, input: decodeAkeruToolInput(toolId, normalized) };
    case "RemoveMcpAccount":
      return { toolId, input: decodeAkeruToolInput(toolId, normalized) };
    case "RenameMcpAccount":
      return { toolId, input: decodeAkeruToolInput(toolId, normalized) };
    case "SetMcpInstructions":
      return { toolId, input: decodeAkeruToolInput(toolId, normalized) };
    case "Task":
      return { toolId, input: decodeAkeruToolInput(toolId, normalized) };
    case "CheckSubagent":
      return { toolId, input: decodeAkeruToolInput(toolId, normalized) };
    case "MessageSubagent":
      return { toolId, input: decodeAkeruToolInput(toolId, normalized) };
    case "StopSubagent":
      return { toolId, input: decodeAkeruToolInput(toolId, normalized) };
  }
}
