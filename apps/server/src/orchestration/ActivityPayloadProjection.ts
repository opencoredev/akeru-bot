import type {
  OrchestrationEvent,
  OrchestrationThreadActivity,
  OrchestrationThreadDetailSnapshot,
} from "@akeru/contracts";
import { AkeruPluginSearchResult } from "@akeru/contracts";
import * as Schema from "effect/Schema";
import { asRecord, asTrimmedString, projectBoundedValue } from "./ActivityPayloadBounds.ts";
import {
  summarizeToolTextOutput,
  projectCommandData,
  projectCommandValue,
  collectChangedFiles,
} from "./CommandActivityPayload.ts";
import { projectMcpToolCallData } from "./McpActivityPayload.ts";
import {
  dropSupersededToolUpdatedActivities,
  dropStaleContextWindowActivities,
} from "./ActivityRetention.ts";

const isPluginSearchResult = Schema.is(AkeruPluginSearchResult);

/**
 * Task-list tools (Akeru's `task_write`, Claude's `TodoWrite`) carry the whole
 * list in their args. Clients only show the step in progress, as a short status.
 */
function projectMemoryOperationCount(data: Record<string, unknown>): number | undefined {
  const operations = asRecord(data.args)?.operations;

  return Array.isArray(operations) ? operations.length : undefined;
}

function projectRawOutput(value: unknown): Record<string, unknown> | undefined {
  const direct = asTrimmedString(value);

  if (direct) {
    const summary = summarizeToolTextOutput(direct);

    return summary ? { content: summary } : undefined;
  }

  const rawOutput = asRecord(value);

  if (!rawOutput) {
    return undefined;
  }

  if (typeof rawOutput.totalFiles === "number" && Number.isFinite(rawOutput.totalFiles)) {
    return {
      totalFiles: rawOutput.totalFiles,
      ...(rawOutput.truncated === true ? { truncated: true } : {}),
    };
  }

  const content = asTrimmedString(rawOutput.content);

  if (content) {
    const summary = summarizeToolTextOutput(content);

    return summary ? { content: summary } : undefined;
  }

  const stdout = asTrimmedString(rawOutput.stdout);

  if (stdout) {
    const summary = summarizeToolTextOutput(stdout);

    return summary ? { content: summary } : undefined;
  }

  const stderr = asTrimmedString(rawOutput.stderr);

  if (stderr) {
    const summary = summarizeToolTextOutput(stderr);

    return summary ? { content: summary } : undefined;
  }

  return undefined;
}

function projectAcpContent(value: unknown): Record<string, unknown> | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const text = value
    .map((entryValue) => {
      const entry = asRecord(entryValue);
      const content = asRecord(entry?.content);

      return entry?.type === "content" && content?.type === "text"
        ? asTrimmedString(content.text)
        : null;
    })
    .filter((entry): entry is string => entry !== null)
    .join("\n");

  const summary = summarizeToolTextOutput(text);

  return summary ? { content: summary } : undefined;
}

function projectPluginSearchResult(value: unknown): AkeruPluginSearchResult | undefined {
  if (!isPluginSearchResult(value)) return undefined;

  return {
    ...value,
    recommendations: value.recommendations.slice(0, 6),
  };
}

/**
 * Removes activity payload fields that no current client reads while retaining
 * the full payload in persistence and the event store.
 */
export function projectActivityPayload(
  activity: OrchestrationThreadActivity,
): OrchestrationThreadActivity {
  const payload = asRecord(activity.payload);
  const data = asRecord(payload?.data);

  if (!payload || !data) {
    return activity;
  }

  const itemStatus = asRecord(data.item)?.status;

  const projectedPayload =
    payload.status === "completed" && (itemStatus === "failed" || itemStatus === "declined")
      ? { ...payload, status: itemStatus }
      : payload;

  if (payload.itemType === "mcp_tool_call") {
    return {
      ...activity,
      payload: {
        ...projectedPayload,
        data: projectMcpToolCallData(data),
      },
    };
  }

  if (payload.itemType === "dynamic_tool_call" && activity.summary === "SearchPlugins") {
    const result = projectPluginSearchResult(data.result);

    if (result) {
      return {
        ...activity,
        payload: {
          ...projectedPayload,
          data: {
            result,
            ...(data.toolCallId !== undefined ? { toolCallId: data.toolCallId } : {}),
          },
        },
      };
    }
  }

  const projectedData: Record<string, unknown> = {};
  const item = projectCommandData(data);

  if (item) {
    projectedData.item = item;
  }

  const command = projectCommandValue(data);

  if (command !== undefined) {
    projectedData.command = projectBoundedValue(command);
  }

  const changedFiles: string[] = [];
  collectChangedFiles(data, changedFiles, new Set<string>(), 0);

  if (changedFiles.length > 0) {
    // Both clients discover file names by walking objects with path-like keys.
    projectedData.files = changedFiles.map((path) => ({ path }));
  }

  if ("toolCallId" in data) {
    projectedData.toolCallId = data.toolCallId;
  }

  if ("kind" in data) {
    projectedData.kind = data.kind;
  }

  const memoryOperationCount = projectMemoryOperationCount(data);

  if (memoryOperationCount !== undefined) {
    projectedData.memoryOperationCount = memoryOperationCount;
  }

  const rawOutput = projectRawOutput(data.rawOutput) ?? projectAcpContent(data.content);

  if (rawOutput) {
    projectedData.rawOutput = rawOutput;
  }

  return {
    ...activity,
    payload: {
      ...projectedPayload,
      data: projectedData,
    },
  };
}

export function projectThreadDetailSnapshot(
  snapshot: OrchestrationThreadDetailSnapshot,
): OrchestrationThreadDetailSnapshot {
  return {
    ...snapshot,
    thread: {
      ...snapshot.thread,
      activities: dropSupersededToolUpdatedActivities(
        dropStaleContextWindowActivities(snapshot.thread.activities),
      ).map(projectActivityPayload),
    },
  };
}

// Published events are immutable and shared by every live subscriber. Project
// each one once so subscribers share the projected object, which also lets the
// live stream budget reuse its serialized-size measurement.
const projectedActivityEvents = new WeakMap<OrchestrationEvent, OrchestrationEvent>();

export function projectActivityEvent(event: OrchestrationEvent): OrchestrationEvent {
  if (event.type !== "thread.activity-appended") {
    return event;
  }

  const cached = projectedActivityEvents.get(event);

  if (cached !== undefined) {
    return cached;
  }

  const projected: OrchestrationEvent = {
    ...event,
    payload: {
      ...event.payload,
      activity: projectActivityPayload(event.payload.activity),
    },
  };

  projectedActivityEvents.set(event, projected);
  // Mark the result as already projected so a repeat call returns it unchanged.
  projectedActivityEvents.set(projected, projected);

  return projected;
}
