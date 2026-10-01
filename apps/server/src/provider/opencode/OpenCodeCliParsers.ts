import * as Predicate from "effect/Predicate";
import { type Agent } from "@opencode-ai/sdk/v2";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

export interface ParsedOpenCodeModelSlug {
  readonly providerID: string;
  readonly modelID: string;
}

export interface OpenCodeSkill {
  readonly name?: string | null;
  readonly description?: string | null;
  readonly location?: string | null;
}

export const OpenCodeSkillSchema = Schema.Struct({
  name: Schema.optionalKey(Schema.NullOr(Schema.String)),
  description: Schema.optionalKey(Schema.NullOr(Schema.String)),
  location: Schema.optionalKey(Schema.NullOr(Schema.String)),
});

export const decodeOpenCodeSkillsCliOutputExit = Schema.decodeUnknownExit(
  Schema.fromJsonString(Schema.Array(OpenCodeSkillSchema)),
);

export const SLUG_LINE_RE = /^(\S+\/\S+)\s*$/;

export const AGENT_HEADER_RE = /^(.+)\s+\((\S+)\)\s*$/;

// Agents that are always hidden in OpenCode but the CLI "agent list" command
// does not expose the hidden flag. Keep in sync with OpenCode agent
// definitions (in the OpenCode repo: packages/opencode/src/agent/agent.ts).
export const KNOWN_HIDDEN_AGENTS = new Set(["compaction", "summary", "title"]);

export const OpenCodeCliModelSchema = Schema.Struct({
  id: Schema.String,
  providerID: Schema.String,
  name: Schema.String,
  capabilities: Schema.optionalKey(
    Schema.Struct({ reasoning: Schema.optionalKey(Schema.Boolean) }),
  ),
  variants: Schema.optionalKey(
    Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Json)),
  ),
});

export type OpenCodeCliModel = typeof OpenCodeCliModelSchema.Type;

const decodeCliModel = Schema.decodeUnknownSync(OpenCodeCliModelSchema);

const decodeAgentMode = Schema.decodeUnknownSync(Schema.Literals(["primary", "subagent", "all"]));

const decodePermissions = Schema.decodeUnknownSync(
  Schema.Array(
    Schema.Struct({
      permission: Schema.String,
      pattern: Schema.String,
      action: Schema.Literals(["allow", "deny", "ask"]),
    }),
  ),
);

/** @internal */
export function parseModelsCliOutput(stdout: string) {
  const providers = new Map<
    string,
    { id: string; name: string; models: { [key: string]: OpenCodeCliModel } }
  >();

  const lines = stdout.split("\n");
  let currentSlug: string | null = null;
  const jsonLines: Array<string> = [];

  const flushModel = () => {
    if (currentSlug !== null && jsonLines.length > 0) {
      const jsonStr = jsonLines.join("\n").trim();

      if (jsonStr.length > 0) {
        try {
          const model = decodeCliModel(JSON.parse(jsonStr), { onExcessProperty: "preserve" });
          const separator = currentSlug.indexOf("/");

          if (separator > 0) {
            const providerID = currentSlug.slice(0, separator);
            const modelID = currentSlug.slice(separator + 1);
            let provider = providers.get(providerID);

            if (!provider) {
              provider = { id: providerID, name: providerID, models: {} };
              providers.set(providerID, provider);
            }

            provider.models[modelID] = model;
          }
        } catch {
          // Skip unparseable model JSON
        }
      }
    }

    currentSlug = null;
    jsonLines.length = 0;
  };

  for (const line of lines) {
    // A model's JSON body is a single `JSON.stringify` line starting with `{`,
    // while a provider/model slug is a bare `provider/model` header. Only the
    // latter can be a slug: without this guard a body line with no interior
    // whitespace and a `/` in one of its values (e.g. an OpenRouter model whose
    // `id` is `vendor/model`) matches SLUG_LINE_RE, so flushModel runs against
    // an empty body and the model is silently dropped.
    const slugMatch = line.trimStart().startsWith("{") ? null : SLUG_LINE_RE.exec(line);

    if (slugMatch) {
      flushModel();
      currentSlug = slugMatch[1]!;
    } else if (currentSlug !== null) {
      jsonLines.push(line);
    }
  }

  flushModel();

  return { providers, connected: [...providers.keys()] };
}

/** @internal */
export function parseAgentListCliOutput(stdout: string): ReadonlyArray<Agent> {
  const agents: Array<Agent> = [];
  const lines = stdout.split("\n");
  let currentHeader: { name: string; mode: string } | null = null;
  const blockLines: Array<string> = [];

  const flushAgent = () => {
    if (currentHeader !== null) {
      const jsonStr = blockLines.join("\n").trim();

      if (jsonStr.length > 0) {
        try {
          const permission = Array.from(decodePermissions(JSON.parse(jsonStr)));
          agents.push({
            name: currentHeader.name,
            mode: decodeAgentMode(currentHeader.mode),
            hidden: KNOWN_HIDDEN_AGENTS.has(currentHeader.name),
            permission,
            options: {},
          });
        } catch {
          // Skip unparseable agent
        }
      }
    }

    currentHeader = null;
    blockLines.length = 0;
  };

  for (const line of lines) {
    const match = AGENT_HEADER_RE.exec(line);

    if (match) {
      flushAgent();
      currentHeader = { name: match[1]!, mode: match[2]! };
    } else if (currentHeader !== null) {
      blockLines.push(line);
    }
  }

  flushAgent();

  return agents;
}

/** @internal */
export function parseSkillsCliOutput(stdout: string): ReadonlyArray<OpenCodeSkill> {
  const result = decodeOpenCodeSkillsCliOutputExit(stdout);

  return Exit.isSuccess(result) ? result.value : [];
}

export function parseOpenCodeModelSlug(
  slug: string | null | undefined,
): ParsedOpenCodeModelSlug | null {
  if (!Predicate.isString(slug)) {
    return null;
  }

  const trimmed = slug.trim();
  const separator = trimmed.indexOf("/");

  if (separator <= 0 || separator === trimmed.length - 1) {
    return null;
  }

  return {
    providerID: trimmed.slice(0, separator),
    modelID: trimmed.slice(separator + 1),
  };
}
