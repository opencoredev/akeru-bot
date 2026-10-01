// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import { assert } from "@effect/vitest";
import * as Schema from "effect/Schema";

export const encodeUnknownJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

export function ownedLogPath(basePath: string, segment: string): string {
  const basename = NodePath.basename(basePath);
  const extension = NodePath.extname(basename);
  const stem = extension.length > 0 ? basename.slice(0, -extension.length) : basename;

  return NodePath.join(NodePath.dirname(basePath), `${stem}.${segment}.log`);
}

export function parseLogLine(line: string) {
  const match = /^\[([^\]]+)\] ([A-Z]+): (.+)$/.exec(line);
  assert.notEqual(match, null);

  if (!match) {
    throw new Error(`invalid log line: ${line}`);
  }

  const observedAt = match[1];
  const stream = match[2];
  const payload = match[3];

  if (!observedAt || !stream || payload === undefined) {
    throw new Error(`invalid log line: ${line}`);
  }

  return {
    observedAt,
    stream,
    payload,
  };
}
