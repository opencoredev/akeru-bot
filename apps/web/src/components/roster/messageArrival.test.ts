import { describe, expect, it } from "vite-plus/test";
import { initialMessageArrivals, reduceMessageArrivals } from "./messageArrival";

const scope = { owner: "bot-1", thread: "thread-1" };

describe("reduceMessageArrivals", () => {
  it("does not animate history present on mount", () => {
    expect(initialMessageArrivals(scope, ["a", "b"]).arrived.size).toBe(0);
  });

  it("marks live messages as arrived and keeps them arrived", () => {
    let state = initialMessageArrivals(scope, ["a"]);
    state = reduceMessageArrivals(state, scope, ["a", "b"]);
    expect([...state.arrived]).toEqual(["b"]);
    state = reduceMessageArrivals(state, scope, ["a", "b", "c"]);
    expect([...state.arrived]).toEqual(["b", "c"]);
  });

  it("returns the same state when nothing changed", () => {
    const state = reduceMessageArrivals(initialMessageArrivals(scope, ["a"]), scope, ["a", "b"]);
    expect(reduceMessageArrivals(state, scope, ["a", "b"])).toBe(state);
  });

  it("treats a bulk load as history", () => {
    const state = reduceMessageArrivals(initialMessageArrivals(scope, []), scope, ["a", "b", "c"]);
    expect(state.arrived.size).toBe(0);
    expect(state.seen.has("c")).toBe(true);
  });

  it("resets on a thread or owner switch", () => {
    const live = reduceMessageArrivals(initialMessageArrivals(scope, ["a"]), scope, ["a", "b"]);
    const otherThread = reduceMessageArrivals(live, { ...scope, thread: "thread-2" }, ["x"]);
    expect(otherThread.arrived.size).toBe(0);
    const otherBot = reduceMessageArrivals(live, { owner: "bot-2", thread: "thread-1" }, ["y"]);
    expect(otherBot.arrived.size).toBe(0);
  });

  it("animates the first message when a new chat links its thread", () => {
    const empty = initialMessageArrivals({ owner: "bot-1", thread: null }, []);
    const state = reduceMessageArrivals(empty, scope, ["a"]);
    expect([...state.arrived]).toEqual(["a"]);
  });
});
