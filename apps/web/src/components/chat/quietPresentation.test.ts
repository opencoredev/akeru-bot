import { describe, expect, it } from "vite-plus/test";
import {
  applyQuietPresentation,
  QUIET_FAILURE_LABEL,
  readStoredPresentationMode,
  storePresentationMode,
} from "./quietPresentation";
import { type TimelineEntry, type WorkLogEntry } from "../../session-logic";

function workEntry(overrides: Partial<WorkLogEntry> & { id: string }): TimelineEntry {
  const entry: WorkLogEntry = {
    createdAt: "2026-01-01T00:00:00Z",
    label: "Ran command",
    tone: "tool",
    ...overrides,
  };

  return { id: entry.id, kind: "work", createdAt: entry.createdAt, entry };
}

function messageEntry(id: string): TimelineEntry {
  return {
    id,
    kind: "message",
    createdAt: "2026-01-01T00:00:00Z",
    message: {
      id,
      role: "assistant",
      text: "done",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      streaming: false,
    },
  } as TimelineEntry;
}

describe("applyQuietPresentation", () => {
  it("keeps messages and drops successful tool rows", () => {
    const entries = [
      messageEntry("m1"),
      workEntry({ id: "w1", command: "ls -la", toolLifecycleStatus: "completed" }),
      messageEntry("m2"),
    ];

    const result = applyQuietPresentation(entries);
    expect(result.map((entry) => entry.id)).toEqual(["m1", "m2"]);
  });

  it("drops thinking and in-progress tool rows", () => {
    const entries = [
      workEntry({ id: "w1", tone: "thinking", label: "Thinking" }),
      workEntry({ id: "w2", toolLifecycleStatus: "inProgress" }),
    ];

    expect(applyQuietPresentation(entries)).toEqual([]);
  });

  it("collapses a failed tool row to a plain status row without command or output", () => {
    const entries = [
      workEntry({
        id: "w1",
        command: "rm -rf /tmp/thing",
        detail: "exit code: 1",
        toolLifecycleStatus: "failed",
        toolData: { raw: "trace" },
      }),
    ];

    const result = applyQuietPresentation(entries);
    expect(result).toHaveLength(1);
    const only = result[0];

    if (only?.kind !== "work") throw new Error("expected work entry");
    expect(only.entry.label).toBe(QUIET_FAILURE_LABEL);
    expect(only.entry.tone).toBe("error");
    expect(only.entry.command).toBeUndefined();
    expect(only.entry.detail).toBeUndefined();
    expect(only.entry.toolData).toBeUndefined();
    expect(only.entry.id).toBe("w1");
  });

  it("keeps agent spawn CTA rows", () => {
    const entries = [
      workEntry({
        id: "w1",
        tone: "thinking",
        label: "Kicked off 2 subagents",
        agentSpawn: { workflowId: null, agentTaskIds: ["t1", "t2"] },
      }),
    ];

    expect(applyQuietPresentation(entries).map((entry) => entry.id)).toEqual(["w1"]);
  });

  it("keeps non-tool info rows", () => {
    const entries = [workEntry({ id: "w1", tone: "info", label: "Checkpoint saved" })];
    expect(applyQuietPresentation(entries).map((entry) => entry.id)).toEqual(["w1"]);
  });
});

describe("presentation mode storage", () => {
  function memoryStorage(): Storage {
    const map = new Map<string, string>();

    return {
      get length() {
        return map.size;
      },
      clear: () => map.clear(),
      getItem: (key: string) => map.get(key) ?? null,
      key: (index: number) => [...map.keys()][index] ?? null,
      removeItem: (key: string) => void map.delete(key),
      setItem: (key: string, value: string) => void map.set(key, value),
    };
  }

  it("defaults to quiet and round-trips the detailed opt-out", () => {
    const storage = memoryStorage();
    expect(readStoredPresentationMode("thread-1", storage)).toBe("quiet");
    storePresentationMode("thread-1", "detailed", storage);
    expect(readStoredPresentationMode("thread-1", storage)).toBe("detailed");
    expect(readStoredPresentationMode("thread-2", storage)).toBe("quiet");
    storePresentationMode("thread-1", "quiet", storage);
    expect(readStoredPresentationMode("thread-1", storage)).toBe("quiet");
    expect(storage.length).toBe(0);
  });
});
