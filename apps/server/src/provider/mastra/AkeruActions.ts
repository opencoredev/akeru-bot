import { AKERU_CREATE_ROUTINE_TOOL_NAME, classifyAkeruSensitivePath } from "@akeru/contracts";
import * as Predicate from "effect/Predicate";
import {
  AKERU_LIST_ROUTINES_TOOL_NAME,
  AKERU_DELETE_ROUTINES_TOOL_NAME,
} from "./AkeruRoutineSchemas.ts";

export type AkeruToolCategory = "read" | "edit" | "execute" | "mcp" | "other";

export type AkeruCriticalAction =
  | "send"
  | "pay"
  | "delete"
  | "production"
  | "secrets"
  | "publish"
  | "sign"
  | "refund"
  | "account";

export const CRITICAL_ACTION_TOKENS: ReadonlyArray<
  readonly [AkeruCriticalAction, ReadonlySet<string>]
> = [
  ["send", new Set(["send", "reply", "dispatch", "deliver"])],
  ["pay", new Set(["pay", "charge", "purchase", "checkout", "transfer"])],
  ["delete", new Set(["delete", "remove", "destroy", "erase", "purge"])],
  ["production", new Set(["deploy", "release", "promote", "prod", "production"])],
  ["secrets", new Set(["secret", "secrets", "credential", "credentials", "password", "token"])],
  ["publish", new Set(["publish", "post", "broadcast"])],
  ["sign", new Set(["sign", "signature", "countersign"])],
  ["refund", new Set(["refund", "reimburse", "reimbursement"])],
];

export const ACCOUNT_SCOPE_TOKENS = new Set(["account", "organization", "workspace", "tenant"]);

export const CHANGE_TOKENS = new Set([
  "change",
  "create",
  "disable",
  "enable",
  "invite",
  "remove",
  "rename",
  "reset",
  "set",
  "update",
]);

export const MUTATING_INTENT_KEYS = new Set([
  "action",
  "intent",
  "method",
  "operation",
  "requesttype",
  "verb",
]);

export const ACTION_TEXT_KEYS = new Set([...MUTATING_INTENT_KEYS, "command", "deliverymode"]);

export const READ_ONLY_INTENT_TOKENS = new Set([
  "find",
  "get",
  "inspect",
  "list",
  "read",
  "search",
  "stat",
  "status",
  "view",
]);

export const CRITICAL_SHELL_ACTIONS: ReadonlyArray<readonly [AkeruCriticalAction, RegExp]> = [
  [
    "delete",
    /(?:^|[;&|]\s*)(?:sudo\s+)?(?:rm|rmdir|unlink)\b|\b(?:drop|truncate)\s+(?:database|schema|table)\b|\bdelete\s+from\b/i,
  ],
  ["delete", /(?:^|[;&|]\s*)(?:(?:sudo|command|builtin|exec|nohup)\s+)*shred\b/i],
  [
    "delete",
    /(?:^|[;&|]\s*)(?:(?:sudo|command|builtin|exec|nohup)\s+)*dd\b[^\n;&|]*(?:\sof=(?:"[^"]*"|'[^']*'|[^\s;&|]+)|\s1?>>?\s*[^\s;&|]+)/i,
  ],
  ["delete", /(?:^|[;&|]\s*)(?:(?:sudo|command|builtin|exec|nohup)\s+)*mv\b/i],
  ["delete", /(?:^|[;&|]\s*)git\s+(?:reset\s+--hard|clean\s+-[a-z]*[fdx][a-z]*)\b/i],
  [
    "delete",
    /\bfind\b[^\n;&|]*\s-exec(?:dir)?\s+(?:(?:sudo|command|builtin|exec|nohup|env)\s+)*(?:rm|rmdir|shred|unlink)\b/i,
  ],
  [
    "delete",
    /\bxargs\b[^\n;&|]*\s(?:(?:sudo|command|builtin|exec|nohup)\s+)*(?:rm|rmdir|shred|unlink)\b/i,
  ],
  ["publish", /(?:^|[;&|]\s*)git\s+push\b/i],
  [
    "production",
    /(?:^|[;&|]\s*)(?:kubectl\s+(?:apply|delete|replace|rollout)|terraform\s+(?:apply|destroy)|docker\s+push)\b/i,
  ],
  [
    "secrets",
    /(?:^|[;&|]\s*)(?:(?:printenv|env)(?:\s|$)|(?:cat|head|tail|less|more|sed|awk|grep|rg)\b[^\n;&|]*(?:\.env\b|\/\.ssh\/id_[\w-]+|credentials?|secrets?|tokens?)|gh\s+auth\s+token|security\s+find-(?:generic|internet)-password|op\s+(?:read|get)|vault\s+(?:kv\s+)?get|aws\s+secretsmanager\s+get-secret-value|gcloud\s+secrets\s+versions\s+access|kubectl\s+get\s+secrets?)\b/i,
  ],
  [
    "send",
    /(?:^|[;&|]\s*)(?:(?:mail|mailx)\b|curl\b[^\n;&|]*(?:--data(?:-raw|-binary)?|-d\b|--form|-F\b|--request\s+post|-X\s*post))/i,
  ],
];

export const SHELL_COMMAND_WRAPPER_PATTERNS = [
  /(?:^|[;&|]\s*)(?:(?:sudo|command|builtin|exec|nohup)\s+)*(?:\/(?:usr\/)?bin\/)?(?:ba|da|z)?sh\s+-[a-z]*c[a-z]*\s+(?:"((?:\\.|[^"])*)"|'([^']*)'|([^\s;&|]+))/gi,
  /(?:\bxargs\b[^\n;&|]*?\s+|\bfind\b[^\n;&|]*\s-exec(?:dir)?\s+)(?:(?:sudo|command|builtin|exec|nohup)\s+)*(?:\/(?:usr\/)?bin\/)?(?:ba|da|z)?sh\s+-[a-z]*c[a-z]*\s+(?:"((?:\\.|[^"])*)"|'([^']*)'|([^\s;&|]+))/gi,
];

export function textTokens(value: string): ReadonlySet<string> {
  return new Set(
    value
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean),
  );
}

export function criticalActionFromText(value: string): AkeruCriticalAction | null {
  const tokens = textTokens(value);

  if (tokens.has("restart") && tokens.has("mcp")) return "production";

  for (const [action, actionTokens] of CRITICAL_ACTION_TOKENS) {
    if ([...actionTokens].some((token) => tokens.has(token))) return action;
  }

  if (
    [...ACCOUNT_SCOPE_TOKENS].some((token) => tokens.has(token)) &&
    [...CHANGE_TOKENS].some((token) => tokens.has(token))
  ) {
    return "account";
  }

  return null;
}

export function criticalActionFromShellCommand(
  value: string,
  wrapperDepth = 0,
): AkeruCriticalAction | null {
  for (const [action, pattern] of CRITICAL_SHELL_ACTIONS) {
    if (pattern.test(value)) return action;
  }

  if (wrapperDepth < 5) {
    for (const wrapperPattern of SHELL_COMMAND_WRAPPER_PATTERNS) {
      for (const match of value.matchAll(wrapperPattern)) {
        const nestedCommand = match[1] ?? match[2] ?? match[3];

        if (!nestedCommand) continue;
        const action = criticalActionFromShellCommand(nestedCommand, wrapperDepth + 1);

        if (action) return action;
      }
    }
  }

  return criticalActionFromText(value);
}

export type AkeruActionInspection = {
  readonly action: AkeruCriticalAction | null;
  readonly hasUnclassifiedIntent: boolean;
};

export function inspectAkeruAction<Input>(toolName: string, args?: Input): AkeruActionInspection {
  const namedAction = criticalActionFromText(toolName);

  if (namedAction) return { action: namedAction, hasUnclassifiedIntent: false };

  const pending: unknown[] = [args];
  const visited = new WeakSet<object>();
  let inspected = 0;
  let entriesInspected = 0;
  let hasUnclassifiedIntent = false;

  while (pending.length > 0 && inspected < 100) {
    const value = pending.pop();
    inspected += 1;

    if (!Predicate.isObject(value) && !Array.isArray(value)) continue;

    if (visited.has(value)) {
      hasUnclassifiedIntent = true;
      continue;
    }

    visited.add(value);

    if (Array.isArray(value)) {
      for (const entry of value) {
        if (entriesInspected >= 100_000) return { action: null, hasUnclassifiedIntent: true };
        entriesInspected += 1;

        if (Predicate.isObjectOrArray(entry) && entry !== null) pending.push(entry);
      }

      continue;
    }

    for (const key in value) {
      if (entriesInspected >= 100_000) return { action: null, hasUnclassifiedIntent: true };
      entriesInspected += 1;

      if (!Object.hasOwn(value, key)) continue;
      const entry: unknown = value[key];
      const normalizedKey = key.toLowerCase();
      const keyedAction = criticalActionFromText(key);

      if (keyedAction) return { action: keyedAction, hasUnclassifiedIntent: false };

      if (ACTION_TEXT_KEYS.has(normalizedKey) && Predicate.isString(entry)) {
        const action =
          normalizedKey === "command"
            ? criticalActionFromShellCommand(entry)
            : criticalActionFromText(entry);

        if (action) return { action, hasUnclassifiedIntent: false };

        if (MUTATING_INTENT_KEYS.has(normalizedKey)) {
          const tokens = textTokens(entry);

          if (![...tokens].some((token) => READ_ONLY_INTENT_TOKENS.has(token))) {
            hasUnclassifiedIntent = true;
          }
        }
      }

      if (
        Predicate.isString(entry) &&
        (normalizedKey === "path" || normalizedKey.endsWith("path")) &&
        classifyAkeruSensitivePath(entry)
      ) {
        return { action: "secrets", hasUnclassifiedIntent: false };
      }

      if (Predicate.isObjectOrArray(entry) && entry !== null) pending.push(entry);
    }
  }

  return { action: null, hasUnclassifiedIntent: hasUnclassifiedIntent || pending.length > 0 };
}

export function criticalAkeruAction<Input>(
  toolName: string,
  args?: Input,
): AkeruCriticalAction | null {
  return inspectAkeruAction(toolName, args).action;
}

export function akeruActionNeedsApproval<Input>(toolName: string, args?: Input): boolean {
  const inspection = inspectAkeruAction(toolName, args);

  return inspection.action !== null || inspection.hasUnclassifiedIntent;
}

export function akeruToolCategory(toolName: string): AkeruToolCategory {
  if (/read|view|grep|search|find|list|stat/i.test(toolName)) return "read";

  if (/edit|write|delete|mkdir|move|rename/i.test(toolName)) return "edit";

  if (/execute|command|shell|process|terminal/i.test(toolName)) return "execute";

  if (/mcp/i.test(toolName)) return "mcp";

  return "other";
}

export function routineToolNeedsGlobalApproval(toolName: string): boolean {
  return (
    toolName !== AKERU_CREATE_ROUTINE_TOOL_NAME &&
    toolName !== AKERU_LIST_ROUTINES_TOOL_NAME &&
    toolName !== AKERU_DELETE_ROUTINES_TOOL_NAME
  );
}
