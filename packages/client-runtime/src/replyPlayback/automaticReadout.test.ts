import { describe, expect, it } from "vite-plus/test";
import {
  createAutomaticReadoutTracker,
  decodeAutomaticReadoutPreference,
} from "./automaticReadout.ts";

const reply = { messageId: "reply", contentVersion: "v1", text: "Hello", successful: true };

describe("automatic reply readout", () => {
  it.each([null, undefined, "false", "1", "TRUE", "{bad}"])("defaults off for %s", (value) => {
    expect(decodeAutomaticReadoutPreference(value)).toBe(false);
  });
  it("accepts only explicit opt-in", () => {
    expect(decodeAutomaticReadoutPreference("true")).toBe(true);
  });
  it("does not replay replies received while disabled", () => {
    const tracker = createAutomaticReadoutTracker();
    tracker.reset("environment/chat", 10);
    expect(tracker.completed("environment/chat", 11, reply)).toBeNull();
    tracker.setEnabled(true);
    expect(tracker.completed("environment/chat", 12, reply)).toBeNull();
    expect(
      tracker.completed("environment/chat", 13, { ...reply, messageId: "new" }),
    ).not.toBeNull();
  });
  it("reads a live completion once, not updates or duplicated events", () => {
    const tracker = createAutomaticReadoutTracker();
    tracker.reset("environment/chat", 10);
    tracker.setEnabled(true);
    expect(tracker.completed("environment/chat", 11, reply)).toEqual(reply);
    expect(tracker.completed("environment/chat", 11, reply)).toBeNull();
    expect(
      tracker.completed("environment/chat", 12, { ...reply, contentVersion: "v2" }),
    ).toBeNull();
  });
  it("baselines history on reconnect and navigation", () => {
    const tracker = createAutomaticReadoutTracker();
    tracker.setEnabled(true);
    tracker.reset("environment/chat", 20);
    expect(tracker.completed("environment/chat", 19, reply)).toBeNull();
    tracker.hydrate(30);
    tracker.hydrate(2);
    expect(tracker.completed("environment/chat", 29, reply)).toBeNull();
    tracker.reset("other/chat", 40);
    expect(tracker.completed("environment/chat", 100, reply)).toBeNull();
    expect(tracker.completed("other/chat", 41, reply)).toEqual(reply);
    tracker.reset(null, 41);
    expect(tracker.completed("other/chat", 42, { ...reply, messageId: "new" })).toBeNull();
  });
  it("ignores failed, empty and invalid completions", () => {
    const tracker = createAutomaticReadoutTracker();
    tracker.reset("chat", 0);
    tracker.setEnabled(true);
    expect(tracker.completed("chat", Number.NaN, reply)).toBeNull();
    expect(tracker.completed("chat", 1, { ...reply, successful: false })).toBeNull();
    expect(tracker.completed("chat", 2, { ...reply, messageId: "empty", text: " " })).toBeNull();
  });
  it("bounds identities without evicting and replaying old replies", () => {
    const tracker = createAutomaticReadoutTracker();
    tracker.reset("chat", 0);
    tracker.setEnabled(true);
    for (let index = 1; index <= 2048; index += 1) {
      expect(
        tracker.completed("chat", index, { ...reply, messageId: String(index) }),
      ).not.toBeNull();
    }
    expect(tracker.completed("chat", 2049, reply)).toBeNull();
    expect(tracker.completed("chat", 2050, { ...reply, messageId: "1" })).toBeNull();
  });
});
